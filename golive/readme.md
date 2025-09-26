## System Design

<img src="./golive/blueprint.png" height="500em"/>

> Microservices! Microservices! Microservices!

### Users

#### Architecture

<img src="./golive/users-file-tree.png" class="float-right"/>

Users are managed with their very own stateless Golang microservice. By using Domain Driven Design, I can keep core functionality separate from the API and database layers.

I also used Hexagonal Architecture. This, combined with DDD, is beneficial because, in addition to the domain layer depending on the database layer, the database layer also depends on the domain layer.

![blueprint](./golive/hex.png)

It's done by using Golang interfaces and gives the illusion of circular dependencies, but with the safety of exposing only specific objects to each layer.

#### Data Layer

No ORM is used, just manual marshaling and unmarshaling entities from MongoDB queries.

#### API Layer

Along with the main restful JSON API, there's also a gRPC interface. It's used by other services primarily to authenticate users. Both run in their own go-routines.

```go
go func() {
    apiErrChan <- httpAPI.Serve()
}()
go func() {
    apiErrChan <- grpcAPI.Serve()
}()
```

### Video Streaming and Rooms

#### RTMP

RTMP stands for Real-Time Messaging Protocol, and it works over TCP. It's used by an OBS client to send video data to the Stream Server.

The Rooms Service has a similar architecture to the Users Service. But its responsibility is keeping track of which users are streaming.

When a client starts streaming, it's the Stream Server that makes a callback request to the Rooms Service, which will then create a room object in its Redis cache. Similarly, when a stream ends, the Stream Service makes a callback request to delete the cached room.

```
# Steam Server configuration.
on_publish http://rooms:8020/create;
on_publish_done http://rooms:8020/delete;
```

These callbacks handle authentication using the stream's keys, which are also user sessions.

```go
func (a *api) handleCreateRoom(w http.ResponseWriter, r *http.Request) {

        // Create a Room for the Session-ID's User.
        err := a.service.CreateRoom(r.Context(), r.FormValue("key"), r.FormValue("name"))
        if err != nil {
                a.httpErr(w, errors.Wrap(err, "cannot create room"))
                return
        }

        // Respond.
        w.WriteHeader(http.StatusOK)
}
```

The a.service.CreateRoom function will make a gRPC request to the Users Service with the stream-key to authenticate the user.

If authentication fails, an error is returned, which will result in a 401 (unauthorized).
If the Stream Server receives anything other than a 200 (ok), the RTMP connection will get canceled, and no stream will occur.

#### HLS

HLS simply stands for HTTP Live Streaming. It's a protocol used for clients (in this case, a Vue.js front-end) to receive video data from a server in small chunks.

As the Stream Server receives video data with RTMP, it saves the data as small .mp4 files, which are seconds long. Each chunk has copies in different resolutions, which HLS handles will switching between if its connection slows.

You can play around with HLS with the <a href="https://hlsjs.video-dev.org/demo" target="_blank">hls.js</a> library which I used for the front-end.
