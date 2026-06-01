## Quick Curl Tests for Auto-Fulfillment

### Prerequisites
```bash
# Login and get token
TOKEN="your-jwt-token-here"
CSRF="your-csrf-token-here"
ORDER_ID="order-id-here"
```

### 1. Get CSRF Token (if needed)
```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/admin/csrf
```

### 2. Check Order Status + Fulfillment Logs
```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/admin/orders/$ORDER_ID/details
```

Response includes:
- `order.status` - should be "processing" or "completed"
- `order.fulfillmentStatus` - "none", "queued", "in_progress", "completed", "failed"
- `order.fulfillmentLog` - array of all attempts with timestamps

### 3. Manually Trigger Fulfillment on an Order
```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-csrf-token: $CSRF" \
  http://localhost:3000/api/admin/orders/$ORDER_ID/retry-fulfill
```

Response:
```json
{
  "success": true,
  "result": {
    "triggered": true/false,
    "reason": "string explaining why it did/didn't trigger"
  }
}
```

### 4. Check Fulfillment Settings
```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/admin/fulfillment/settings
```

### 5. Check Provider Health
```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/admin/fulfillment/health
```

Response shows balance/status for all configured providers.

### Full Workflow Example
```bash
# 1. Get fresh token (via send-otp + verify-otp, or from storage)
# 2. Get CSRF token
CSRF=$(curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/admin/csrf | jq -r '.csrfToken')

# 3. Check settings
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/admin/fulfillment/settings | jq '.'

# 4. Trigger fulfillment
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-csrf-token: $CSRF" \
  http://localhost:3000/api/admin/orders/ORDER_ID_HERE/retry-fulfill | jq '.'

# 5. Check the result
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/admin/orders/ORDER_ID_HERE/details | jq '.order.fulfillmentLog'
```

### Expected Fulfillment Log Entries

Successful fulfillment:
```
[
  { timestamp: "...", level: "info", message: "Starting auto-fulfill for order X" },
  { timestamp: "...", level: "info", message: "Using provider: istar" },
  { timestamp: "...", level: "success", message: "istar fulfilled successfully" }
]
```

Failed fulfillment (shows reason):
```
[
  { timestamp: "...", level: "info", message: "Auto-fulfill disabled in settings" },
  { timestamp: "...", level: "warning", message: "Skipping fulfillment" }
]
```

### Debugging Flow

1. **No logs appear in server** → Server not restarted after latest code
2. **Logs show "auto-fulfill disabled"** → Check Admin > Auto-Fulfillment > Enable toggle
3. **Logs show "provider is manual"** → Check Admin > Auto-Fulfillment > Stars provider not set to "istar"
4. **Logs show "no configured providers"** → Check ISTAR_API_KEY env var is set
5. **Logs show provider error** → Run "Check provider health" button in admin to test connection
6. **Order status still "processing" after 5 minutes** → Check if payment verification succeeded (status should become "processing" then auto-fulfill)
