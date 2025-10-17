# StarStore Version System

## Overview
StarStore now uses a dynamic version system that automatically updates based on deployment date, specifically designed for Railway deployments.

## Current Version: **1.10.17**
- **Format**: `MAJOR.MINOR.PATCH`
- **MAJOR**: Year - 2024 (2025 = 1, 2026 = 2, etc.)
- **MINOR**: Month (1-12)
- **PATCH**: Day (1-31)

## How It Works

### Automatic Updates
The version system automatically runs during Railway deployment through:
- `postinstall` script: Runs after npm install
- `build` script: Runs during build process
- `start` script: Runs before server starts

### Manual Updates
You can manually update the version using:
```bash
# Update version now
node update-version-now.js

# Or use the Railway version generator directly
node generate-railway-version.js
```

### Admin Commands
Admins can check version info via Telegram:
- `/version` - Show current version information
- `/version update` - Update version immediately (if implemented)

## Files Updated

### Core Files
- `package.json` - Contains the current version
- `generate-railway-version.js` - Railway-compatible version generator
- `update-version-now.js` - Manual version update utility

### Frontend Files
- `public/js/version.js` - Frontend version manager
- `public/js/version-display.js` - Version display component

## API Endpoints

### `/api/version`
Returns comprehensive version information:
```json
{
  "version": "1.10.17",
  "buildDate": "2025-10-17",
  "buildNumber": "abc12345",
  "commitHash": "1793a6c",
  "branch": "main",
  "displayVersion": "StarStore v1.10.17",
  "deployment": {
    "id": "railway-deployment-id",
    "environment": "production",
    "service": "starstore"
  }
}
```

## Railway Integration

The system automatically detects Railway environment variables:
- `RAILWAY_DEPLOYMENT_ID` - Used as build number
- `RAILWAY_ENVIRONMENT` - Deployment environment
- `RAILWAY_GIT_COMMIT_SHA` - Git commit hash
- `RAILWAY_GIT_BRANCH` - Git branch
- `RAILWAY_GIT_COMMIT_MESSAGE` - Last commit message

## Benefits

1. **No More Hardcoded Versions**: Eliminates the old hardcoded `9.1.27`
2. **Automatic Updates**: Version updates with each deployment
3. **Date-Based Versioning**: Easy to understand when the version was deployed
4. **Railway Optimized**: Works perfectly with Railway's deployment system
5. **Fallback Support**: Works even without git history

## Troubleshooting

If version doesn't update:
1. Check Railway deployment logs for version generation
2. Manually run `node generate-railway-version.js`
3. Verify `package.json` has been updated
4. Check `/api/version` endpoint response

## Future Enhancements

- Semantic versioning based on commit messages
- Version history tracking
- Automatic changelog generation
- Integration with Railway's build notifications