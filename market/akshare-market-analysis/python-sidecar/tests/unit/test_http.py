import http.client
import json
import threading

from akshare_service.main import _Server


class HealthService:
    def health(self):
        return {"ok": True, "schemaVersion": 1}

    def dispatch(self, path, payload):
        return {"path": path, "payload": payload}


def request(port, method, path, token=None, body=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    if body is not None:
        encoded = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = str(len(encoded))
    else:
        encoded = None
    connection.request(method, path, body=encoded, headers=headers)
    response = connection.getresponse()
    value = json.loads(response.read().decode("utf-8"))
    connection.close()
    return response.status, value


def test_loopback_http_requires_bearer_token() -> None:
    server = _Server(("127.0.0.1", 0), "test-token", HealthService())
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        assert request(server.server_address[1], "GET", "/health")[0] == 401
        status, value = request(server.server_address[1], "GET", "/health", token="test-token")
        assert status == 200 and value["ok"] is True
        status, value = request(server.server_address[1], "POST", "/v1/test", token="test-token", body={"ok": 1})
        assert status == 200 and value["payload"] == {"ok": 1}
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
