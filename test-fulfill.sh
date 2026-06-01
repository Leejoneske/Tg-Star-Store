#!/bin/bash
# Test auto-fulfillment flow with curl

set -e

# Configuration
API_URL="${1:-http://localhost:3000}"
ADMIN_ID="${2:-123}"  # Your Telegram ID
ORDER_ID="${3:-}"
COOKIES_FILE="/tmp/admin_cookies.txt"

echo "=== StarStore Fulfillment Test Script ==="
echo "API URL: $API_URL"
echo "Admin Telegram ID: $ADMIN_ID"
echo ""

# Step 1: Authenticate
echo "📝 Step 1: Getting OTP..."
OTP_RESPONSE=$(curl -s -c "$COOKIES_FILE" -X POST "$API_URL/api/admin/send-otp" \
  -H "Content-Type: application/json" \
  -d "{\"telegramId\": \"$ADMIN_ID\"}")

echo "OTP Response: $OTP_RESPONSE"
echo ""
echo "⚠️  Check your Telegram for the OTP code"
read -p "Enter the OTP code: " OTP_CODE

# Step 2: Verify OTP
echo ""
echo "✅ Verifying OTP..."
AUTH_RESPONSE=$(curl -s -b "$COOKIES_FILE" -c "$COOKIES_FILE" -X POST "$API_URL/api/admin/verify-otp" \
  -H "Content-Type: application/json" \
  -d "{\"telegramId\": \"$ADMIN_ID\", \"otp\": \"$OTP_CODE\"}")

echo "Auth Response: $AUTH_RESPONSE"
TOKEN=$(echo "$AUTH_RESPONSE" | grep -o '"token":"[^"]*' | cut -d'"' -f4)
if [ -z "$TOKEN" ]; then
    echo "❌ Failed to get token. Check OTP code."
    exit 1
fi
echo "✅ Authenticated! Token: ${TOKEN:0:20}..."
echo ""

# Step 3: Get CSRF token
echo "🔐 Step 2: Getting CSRF token..."
CSRF_RESPONSE=$(curl -s -b "$COOKIES_FILE" \
  -H "Authorization: Bearer $TOKEN" \
  "$API_URL/api/admin/csrf")

CSRF_TOKEN=$(echo "$CSRF_RESPONSE" | grep -o '"csrfToken":"[^"]*' | cut -d'"' -f4)
if [ -z "$CSRF_TOKEN" ]; then
    echo "❌ Failed to get CSRF token: $CSRF_RESPONSE"
    exit 1
fi
echo "✅ Got CSRF token: ${CSRF_TOKEN:0:20}..."
echo ""

# Step 4: If no order provided, list recent orders
if [ -z "$ORDER_ID" ]; then
    echo "📋 Step 3: Fetching recent orders..."
    ORDERS=$(curl -s -b "$COOKIES_FILE" \
      -H "Authorization: Bearer $TOKEN" \
      "$API_URL/api/admin/orders?limit=10")
    
    echo "Recent Orders:"
    echo "$ORDERS" | head -c 500
    echo ""
    echo ""
    read -p "Enter ORDER_ID to test: " ORDER_ID
    if [ -z "$ORDER_ID" ]; then
        echo "❌ No order ID provided"
        exit 1
    fi
fi

echo "🎯 Testing fulfillment for Order: $ORDER_ID"
echo ""

# Step 5: Check order status
echo "📊 Step 4: Checking order status..."
ORDER_STATUS=$(curl -s -b "$COOKIES_FILE" \
  -H "Authorization: Bearer $TOKEN" \
  "$API_URL/api/admin/orders/$ORDER_ID/details")

echo "Order Details:"
echo "$ORDER_STATUS" | grep -o '"status":"[^"]*\|"fulfillmentStatus":"[^"]*\|"fulfillmentLog":\[\|"message":"[^"]*'
echo ""

# Step 6: Trigger retry (manual fulfillment)
echo "⚡ Step 5: Triggering fulfillment retry..."
RETRY_RESPONSE=$(curl -s -b "$COOKIES_FILE" \
  -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-csrf-token: $CSRF_TOKEN" \
  -H "Content-Type: application/json" \
  "$API_URL/api/admin/orders/$ORDER_ID/retry-fulfill")

echo "Retry Response:"
echo "$RETRY_RESPONSE"
echo ""

# Step 7: Check logs after fulfillment
echo "📜 Step 6: Checking updated fulfillment logs..."
sleep 2

ORDER_LOGS=$(curl -s -b "$COOKIES_FILE" \
  -H "Authorization: Bearer $TOKEN" \
  "$API_URL/api/admin/orders/$ORDER_ID/details")

echo "Updated Order Status & Logs:"
echo "$ORDER_LOGS" | jq '.order | {id, status, fulfillmentStatus, fulfillmentError, fulfillmentLog}' 2>/dev/null || echo "$ORDER_LOGS" | head -c 800

echo ""
echo "✅ Test complete!"
echo ""
echo "💡 Check server logs for entries like:"
echo "   [fulfillment] Order $ORDER_ID auto-fulfill attempt: {...}"
