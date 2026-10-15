"""M1 readiness only. Validation/rendering endpoints belong to M3/M5."""
from http.server import BaseHTTPRequestHandler,HTTPServer
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if self.path=='/live' else 404)
        self.send_header('Cache-Control','no-store');self.end_headers()
    def log_message(self,*args):pass
HTTPServer(('0.0.0.0',8080),Handler).serve_forever()
