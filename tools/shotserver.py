import base64, http.server, os, urllib.parse
OUT = os.environ.get('SHOT_DIR', '/tmp/offroad-shots')
os.makedirs(OUT, exist_ok=True)
class H(http.server.BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()
    def do_POST(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        name = os.path.basename(q.get('name', ['shot'])[0]) + '.jpg'
        data = self.rfile.read(int(self.headers['Content-Length'])).decode()
        b64 = data.split(',', 1)[1]
        open(os.path.join(OUT, name), 'wb').write(base64.b64decode(b64))
        self.send_response(200); self._cors(); self.end_headers(); self.wfile.write(b'ok')
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', 5199), H).serve_forever()
