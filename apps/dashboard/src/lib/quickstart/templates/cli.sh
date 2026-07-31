{{API_KEY_SH}}
export BOXLITE_REST_URL="{{REST_API_URL}}"

boxlite run --rm --name "sdk-quickstart-cli-$(date +%s)" \
  ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0 \
  echo "Hello from BoxLite CLI"
