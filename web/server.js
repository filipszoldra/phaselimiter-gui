const http = require("http");
const fs = require("fs");
const path = require("path");
const root = path.dirname(__filename);
const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
http.createServer((req, res) => {
  const f = path.join(root, req.url === "/" ? "index.html" : req.url);
  try {
    const ext = path.extname(f);
    res.writeHead(200, { "Content-Type": mime[ext] || "text/plain" });
    res.end(fs.readFileSync(f));
  } catch (e) {
    res.writeHead(404); res.end("404");
  }
}).listen(7734, () => process.stdout.write("ready\n"));
