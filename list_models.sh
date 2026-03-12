#!/bin/bash
KEY=$(grep NVIDIA_API_KEY /home/azureuser/ChatForge/.env | cut -d= -f2)
BASE="https://integrate.api.nvidia.com/v1/chat/completions"
MODELS=(
  "qwen/qwen2.5-coder-32b-instruct"
  "qwen/qwen3-coder-480b-a35b-instruct"
  "mistralai/codestral-22b-instruct-v0.1"
  "deepseek-ai/deepseek-r1-distill-qwen-32b"
  "nvidia/llama-3.1-nemotron-70b-instruct"
  "meta/llama-3.3-70b-instruct"
  "google/gemma-3-27b-it"
  "ibm/granite-34b-code-instruct"
  "mistralai/mistral-small-3.1-24b-instruct-2503"
  "nv-mistralai/mistral-nemo-12b-instruct"
  "microsoft/phi-4-mini-instruct"
)
for m in "${MODELS[@]}"; do
  # Request with very high max_tokens to see what the API allows or errors
  RESP=$(curl -s -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d "{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"say ok\"}],\"max_tokens\":16384}" \
    "$BASE")
  TOKENS=$(echo "$RESP" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('usage',{}).get('completion_tokens','ERR'),d.get('choices',[{}])[0].get('finish_reason','?'))" 2>/dev/null || echo "FAIL")
  echo "$m => $TOKENS"
done
