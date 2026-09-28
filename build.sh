#!/bin/bash
mkdir -p .vercel/output/static
cp index.html .vercel/output/static/
cp -r public/* .vercel/output/static/
