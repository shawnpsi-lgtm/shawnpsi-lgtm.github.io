#!/bin/sh
# Raycast script command: type "ask shawn", Tab, then your question.
# @raycast.schemaVersion 1
# @raycast.title Ask Shawn
# @raycast.mode fullOutput
# @raycast.packageName Shawn AI
# @raycast.icon https://shawnsingh.me/images/shawn-ai-icon.png
# @raycast.argument1 { "type": "text", "placeholder": "question" }
curl -sS --fail-with-body -G --data-urlencode "q=$1" --data plain https://groq-chat.shawnpsi.workers.dev/api
