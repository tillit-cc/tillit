#!/bin/bash

# Script to generate RSA key pair for JWT authentication

echo "Generating RSA keys for JWT..."

# Create keys directory if it doesn't exist
mkdir -p keys

# Generate private key (4096 bits — aligned with docker-entrypoint.sh and first-boot.sh)
openssl genpkey -algorithm RSA -out keys/private.pem -pkeyopt rsa_keygen_bits:4096

# Generate public key from private key
openssl pkey -in keys/private.pem -pubout -out keys/public.pem

echo "✓ RSA keys generated successfully in ./keys/"
echo "  - private.pem (keep this secret!)"
echo "  - public.pem"
