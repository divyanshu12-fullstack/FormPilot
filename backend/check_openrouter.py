import os
import httpx
from dotenv import load_dotenv

load_dotenv()

def check():
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key or api_key == "your_key_here":
        print("Error: OPENROUTER_API_KEY is not set in .env")
        return
    
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    
    data = {
        "model": "meta-llama/llama-3-8b-instruct:free", # Free fast model for ping
        "messages": [{"role": "user", "content": "Say hello in one word."}]
    }
    
    try:
        response = httpx.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers=headers,
            json=data,
            timeout=10.0
        )
        response.raise_for_status()
        print(f"Success! Model says: {response.json()['choices'][0]['message']['content']}")
    except Exception as e:
        print(f"API Call Failed: {e}")

if __name__ == "__main__":
    check()
