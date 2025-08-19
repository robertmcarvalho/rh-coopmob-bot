#!/usr/bin/env bash
set -e
curl -s -X POST http://localhost:8000/webhook -H "Content-Type: application/json" -d @tests/payloads/whatsapp_text.json | jq . || true
curl -s -X POST http://localhost:8000/webhook -H "Content-Type: application/json" -d @tests/payloads/whatsapp_list_reply.json | jq . || true
