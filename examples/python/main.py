import os
import requests

BASE_URL = os.environ["VOXYDB_URL"].rstrip("/")
PROJECT_ID = os.environ["VOXYDB_PROJECT_ID"]
API_KEY = os.environ["VOXYDB_WRITE_KEY"]
COLLECTION_URL = f"{BASE_URL}/v1/projects/{PROJECT_ID}/collections/tasks/records"
HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json",
    "Idempotency-Key": "python-demo-task-001",
}

created = requests.post(
    COLLECTION_URL,
    headers=HEADERS,
    json={"data": {"title": "Connect Python to VoxyDB", "done": False}},
    timeout=20,
)
created.raise_for_status()
print("Created:", created.json()["record"])

read_headers = {"Authorization": f"Bearer {os.environ['VOXYDB_READ_KEY']}"}
records = requests.get(COLLECTION_URL, headers=read_headers, timeout=20)
records.raise_for_status()
print("Records:", records.json()["records"])
