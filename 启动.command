#!/bin/bash
cd "$(dirname "$0")"

export OPENAI_API_KEY=$(grep '^KEY=' proxy/.env | cut -d= -f2)
export OPENAI_BASE_URL="http://localhost:18923/v1"

node app.js
