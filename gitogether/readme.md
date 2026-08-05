## Git Integration

### refs

Creating a server that the Git client can interface with is quite involved. For the Git client to do basically anything with a GitTogether repository, it needs to be able to read its refs from a /refs endpoint. This is what that looks like with FastAPI:

```python
@router.get("/{username}/{reponame}/info/refs")
async def repo_info(
    _: git_auth,
    username: UsernamePathParam,
    reponame: ReponamePathParam,
    service: str,
):
    try:
        stdout = subprocess.run(
            ["git", service[4:], "--stateless-rpc", "--advertise-refs", "."],
            cwd=Config.repositories_path / username / reponame,
            capture_output=True,
        ).stdout

        # Formate response.
        res = b"# service=" + service.encode()
        l = len(res) + 4
        l = b"%04x" % l  # Convert length into hexadecimal.
        res = l + res + b"0000" + stdout

        return Response(content=res, media_type=f"application/x-{service}-advertisement")

    except FileNotFoundError:
        return Response(status_code=status.HTTP_404_NOT_FOUND)
```

It's up to the Git client to make this request. The username and reponame correspond with the directory of the repository. The service parameter can be ```git-upload-pack``` or ```git-receive-pack``` depending on whether the client wants to upload data. The ```git_auth``` is middleware we'll get to in a bit.

The server uses ```git``` and the ```service``` parameter as a subcommand to get the repository's refs. It then prefixes the response with some extra info that the git client needs.

### Streaming Git objects

```python
@router.post("/{username}/{reponame}/{service}")
async def repo_service(
    req: Request,
    _: git_auth,
    username: UsernamePathParam,
    reponame: ReponamePathParam,
    service: str,
):
    try:
        process = subprocess.Popen(
            ["git", service[4:], "--stateless-rpc", "."],
            cwd=Config.repositories_path / username / reponame,
            stdout=subprocess.PIPE,
            stdin=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        assert process.stdin is not None

        async for chunk in req.stream():
            process.stdin.write(chunk)

        stdout, stderr = process.communicate()
        try:
            stdout = io.BytesIO(stdout)
        finally:
            if process.wait() != 0:
                print(stderr)

        return StreamingResponse(content=stdout, media_type=f"application/x-{service}-result")

    except FileNotFoundError:
        return Response(status_code=status.HTTP_404_NOT_FOUND)
```

This next endpoint is for whenever the Git client needs to stream any potentially large data. The server uses the service parameter to run ```git upload-pack``` or ```git receive-pack``` depending on if the client is uploading or downloading data.

These two endpoints are what allow Git clients to talk to GiTogether's remote repositories.

### Authentication

Git's HTTP auth is pretty old school, but it works. The Git client first tries to make requests without authorization because operations like cloning a public repo don't require it. That's why the middleware checks whether the repo is private before moving on to actual username/password authorization.

```python
# middleware
class GitAuth(HTTPBasic):
    async def __call__(
        self,
        req: Request,
        username: UsernamePathParam,
        reponame: ReponamePathParam,
        service: str,
    ) -> Tuple[User | None, Repository]:
        async with acquire() as conn:
            conn: Connection

            repo = await Repository.select_by_names(conn, username, reponame)
            if not repo:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)

            if not repo.private and service == "git-upload-pack":
                return (None, repo)

            credentials = await super().__call__(req)
            assert credentials is not None

            user = await User.select_by_username(conn, credentials.username)
            if (
                user is None
                or not bcrypt.checkpw(credentials.password.encode(), user.password)
                or (
                    repo.owner_id != user.user_id
                    and not await Repository.has_contributor(conn, repo.repository_id, user.user_id)
                )
            ):
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)

        return (user, repo)
```

### Pull Requests

When a pull-request is created, a record of it is saved in the database. It points to other target and source repository rows in the database. The pull-request is completed with the ```/pull-requests/{pull_request_id}/complete``` endpoint.

It first retrives the pull-request and repository info from the database and does some authorization. Then it retrives the repositories and their branche references from disk. The merge is done in memory, and then the merge-commit is written to disk. There are many ways to implement this functionality. But doing it like this makes the process atomic and allows for handling merge conflicts in memory.

```python
@router.patch("/pull-requests/{pull_request_id}/complete", name="complete_pull_request")
async def complete_pull_request(
    res: Response,
    session: DepSession,
    pull_request_id: str,
):
    if not session:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)

    async with acquire() as conn:
        async with conn.transaction():

            # Get the pull-request.
            pull_req = await PullRequest.select_by_id(conn, UUID(pull_request_id))
            if not pull_req:
                raise RequestValidationError([PydanticCustomError("pull_request_not_found", "This pull request doesn't exist.")])

            # Ensure the user is the owner or a contributor.
            if pull_req.owner_id != session.user.user_id and not await Repository.has_contributor(conn, pull_req.target_id, session.user.user_id):
                raise RequestValidationError([PydanticCustomError("unauthorized", "You're not authorized to complete this pull request.")])

            # Get the target and source repository from the database.
            target_data = await RepositoryPageView.select_by_id(conn, pull_req.target_id)
            if not target_data:
                raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)
            source_data = target_data

            # Get the target repository from the filesystem.
            target = pygit2.Repository(Config.repositories_path / target_data.owner_username / target_data.reponame)

            # Initialize the target and source branch names as heads.
            target_branch_ref_name = f"refs/heads/{pull_req.target_branch}"
            source_branch_ref_name = f"refs/heads/{pull_req.source_branch}"

            # If there is a separate source_id, that means it's a branch from a remote repo.
            if pull_req.source_id:

                # Get the other repo with the source branch.
                source_data = await RepositoryPageView.select_by_id(conn, pull_req.source_id)
                if not source_data:
                    raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)

                # Initialize the source branch name as a remote.
                source_branch_ref_name = f"refs/remotes/{pull_req.pull_request_id}/{pull_req.source_branch}"

                # Have the target repo fetch the remote source branch.
                target.remotes[str(pull_req.pull_request_id)].fetch()

            # Get the refs of the target and source branches.
            target_branch_ref = target.lookup_reference(target_branch_ref_name)
            source_branch_ref = target.lookup_reference(source_branch_ref_name)

            # Perform a merge analysis to decide which merge strategy to use.
            analasis, _ = target.merge_analysis(source_branch_ref.target, target_branch_ref_name)

            merge_oid: pygit2.Oid | str = ""
            merge_message = ""

            # Fast-forward merge by pointing the target branch to the source branch.
            if analasis & pygit2.GIT_MERGE_ANALYSIS_FASTFORWARD:
                merge_oid = source_branch_ref.target
                merge_message = f"Merge {pull_req.source_branch} into {pull_req.target_branch}"

            # Normal merge
            elif analasis & pygit2.GIT_MERGE_ANALYSIS_NORMAL:

                # Merge the branches and check for conflicts all in memory.
                index = target.merge_commits(target_branch_ref.target, source_branch_ref.target)
                if index.conflicts:
                    raise RequestValidationError([PydanticCustomError("merge_conflicts_deteted", "Merge conflicts detected.")])

                # Write the new merge commit to disk.
                tree_oid = index.write_tree(target)

                # Set author info for the merge commit.
                author = pygit2.Signature(session.user.username, f"{session.user.username}@gitogether.com")
                committer = author
                merge_message = f"Merge {pull_req.source_branch} from {source_data.owner_username}/{source_data.reponame} into {pull_req.target_branch}"
                merge_oid = target.create_commit(
                    None, author, committer, merge_message, tree_oid,
                    [target_branch_ref.target, source_branch_ref.target],
                )

            # If the target branch is already up to date, skip the merge.
            if not (analasis & pygit2.GIT_MERGE_ANALYSIS_UP_TO_DATE):

                # Set the target branch's HEAD to point to the merge commit.
                subprocess.run(
                    [
                        "git",
                        "--git-dir",
                        str(Config.repositories_path / target_data.owner_username / target_data.reponame),
                        "update-ref",
                        "-m",
                        merge_message,
                        target_branch_ref_name,
                        str(merge_oid),
                        str(target_branch_ref.target),
                    ],
                    check=True,
                    capture_output=True,
                )

            res.headers["HX-Redirect"] = f"/{target_data.owner_username}/{target_data.reponame}/code/{pull_req.target_branch}"
```
