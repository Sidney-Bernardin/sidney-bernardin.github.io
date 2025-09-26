const converter = new showdown.Converter()

fetch("golive/readme.md")
    .catch((err) => alert(err))
    .then((res) => res.text())
    .then((txt) => {
        document.querySelector(".project#golive .md").innerHTML = converter.makeHtml(txt)
        console.log(hljs.highlightAll())
    })



var cursor = document.createElement("div")
cursor.classList.add("cursor")
document.body.appendChild(cursor)

var cursorBorder = document.createElement("div")
cursorBorder.classList.add("cursor-border")
document.body.appendChild(cursorBorder)

if (cursor) {
    window.addEventListener("mousemove", (e) => {
        if (e.target.tagName !== "BUTTON" && e.target.tagName !== "A") {

            cursor.style = ""
            cursor.style.transform = `translate(calc(${e.clientX}px - 50%), calc(${e.clientY}px - 50%))`

            cursorBorder.style = ""
            cursorBorder.style.transform = `translate(calc(${e.clientX}px - 50%), calc(${e.clientY}px - 50%))`

            cursorBorder.classList.remove("on-focus")
        } else {
            cursor.style.background = "transparent"

            cursorBorder.classList.add("on-focus")
            cursorBorder.style.transform = `translate(${e.target.offsetParent.offsetLeft + e.target.offsetLeft}px, ${e.target.offsetParent.offsetTop + e.target.offsetTop}px)`
            cursorBorder.style.width = e.target.clientWidth + "px"
            cursorBorder.style.height = e.target.clientHeight + "px"
        }
    })
}
