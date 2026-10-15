#!/bin/bash
set -eu
exec 3<>/dev/tcp/localhost/9000
printf 'GET /health/ready HTTP/1.0\r\n\r\n' >&3
IFS= read -r response <&3
[[ "$response" == *" 200 "* ]]
