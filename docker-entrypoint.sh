#!/bin/sh
set -e

# Directory for keys (should be mounted as PersistentVolume in K8s)
KEYS_DIR="${KEYS_DIR:-/app/keys}"

echo "=== Key Generation Check ==="
echo "KEYS_DIR: $KEYS_DIR"
echo "Current user: $(whoami)"
echo "Current directory: $(pwd)"

# Ensure keys directory exists
mkdir -p "$KEYS_DIR"

# Check if both key files exist, are readable, and are non-empty
PRIVATE_KEY="$KEYS_DIR/private.pem"
PUBLIC_KEY="$KEYS_DIR/public.pem"

NEED_GENERATION="false"

# Check private key
if [ -f "$PRIVATE_KEY" ]; then
    echo "Private key exists: YES"
    if [ -r "$PRIVATE_KEY" ]; then
        echo "Private key readable: YES"
        if [ -s "$PRIVATE_KEY" ]; then
            echo "Private key non-empty: YES"
        else
            echo "Private key non-empty: NO (file is empty)"
            NEED_GENERATION="true"
        fi
    else
        echo "Private key readable: NO"
        NEED_GENERATION="true"
    fi
else
    echo "Private key exists: NO"
    NEED_GENERATION="true"
fi

# Check public key
if [ -f "$PUBLIC_KEY" ]; then
    echo "Public key exists: YES"
    if [ -r "$PUBLIC_KEY" ]; then
        echo "Public key readable: YES"
        if [ -s "$PUBLIC_KEY" ]; then
            echo "Public key non-empty: YES"
        else
            echo "Public key non-empty: NO (file is empty)"
            NEED_GENERATION="true"
        fi
    else
        echo "Public key readable: NO"
        NEED_GENERATION="true"
    fi
else
    echo "Public key exists: NO"
    NEED_GENERATION="true"
fi

echo "Need generation: $NEED_GENERATION"

if [ "$NEED_GENERATION" = "true" ]; then
    echo "Generating new RSA key pair..."

    # Remove any existing invalid files
    rm -f "$PRIVATE_KEY" "$PUBLIC_KEY"

    # Generate 4096-bit RSA private key
    openssl genpkey -algorithm RSA -out "$PRIVATE_KEY" -pkeyopt rsa_keygen_bits:4096

    # Extract public key
    openssl rsa -pubout -in "$PRIVATE_KEY" -out "$PUBLIC_KEY"

    # Set proper permissions
    chmod 600 "$PRIVATE_KEY"
    chmod 644 "$PUBLIC_KEY"

    echo "RSA key pair generated successfully"
else
    echo "RSA key pair already exists and is valid - skipping generation"
fi

# Debug: show key file details
echo "=== Key Files ==="
ls -la "$KEYS_DIR/"
echo "================="

# Export key paths for the application
export PRIVATE_KEY_PATH="$PRIVATE_KEY"
export PUBLIC_KEY_PATH="$PUBLIC_KEY"

# Execute the main command
exec "$@"