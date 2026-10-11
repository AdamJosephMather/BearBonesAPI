import json
import requests
import secrets

# Server configuration
BASE_URL = "https://bearbones.duckdns.org:3982"

canvas_token = secrets.canvas_token

def test_sync():
	print("\n--- Testing /sync Endpoint ---")
	url = f"{BASE_URL}/sync"

	# Payload containing the token string
	payload = {"token": canvas_token}

	try:
		response = requests.post(url, json=payload, verify=True)
		print(f"Status Code: {response.status_code}")
		print("Response JSON:", response.json())
	except Exception as e:
		print(f"Error connecting to /sync: {e}")


def test_findit():
	print("\n--- Testing /findit Endpoint ---")
	url = f"{BASE_URL}/findit"

	# Payload containing some state data (JSON)
	state_payload = {
			"token": canvas_token,
			"messages": [
				{"content":"Do I have any conflicts with my midterm?", "role":"user"}
			]
	}

	try:
		response = requests.post(url, json=state_payload, verify=True)
		print(f"Status Code: {response.status_code}")
		print("Response JSON:", response.json())
	except Exception as e:
		print(f"Error connecting to /findit: {e}")


if __name__ == "__main__":
	print(f"Starting API tests against {BASE_URL}...")
	test_sync()
	test_findit()