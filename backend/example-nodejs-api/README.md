# Example Node.js API for AWS ECS Fargate

This is a sample Node.js REST API server designed to run on AWS ECS Fargate.

## Features

- Express.js based REST API
- Health check endpoint for ALB target groups
- Security headers with Helmet
- CORS support
- Request logging with Morgan
- Multi-stage Docker build for smaller images
- Non-root user for security
- Graceful shutdown handling
- Docker health checks

## API Endpoints

### Health Check
- `GET /health` - Returns service health status (used by ALB health checks)

### Main Endpoints
- `GET /` - API information
- `GET /api/v1/items` - Get all items
- `GET /api/v1/items/:id` - Get item by ID
- `POST /api/v1/items` - Create new item
- `GET /api/v1/info` - Get system and environment information

## Local Development

### Install dependencies
```bash
npm install
```

### Run in development mode
```bash
npm run dev
```

### Run in production mode
```bash
npm start
```

The server will start on port 8080 by default.

## Docker

### Build the image
```bash
docker build -t example-nodejs-api .
```

### Run the container
```bash
docker run -p 8080:8080 example-nodejs-api
```

### Test the API
```bash
curl http://localhost:8080/health
curl http://localhost:8080/api/v1/items
```

## ECS Fargate Deployment

This application is designed to run on AWS ECS Fargate with:
- Port 8080 exposed
- Health check endpoint at `/health`
- Graceful shutdown support
- Non-root user execution
- Optimized multi-stage build

### Environment Variables

- `PORT` - Server port (default: 8080)
- `NODE_ENV` - Environment (development/production)
- `AWS_REGION` - AWS region (set by ECS)
- `AWS_AVAILABILITY_ZONE` - Availability zone (optional)

## Security Features

- Helmet.js for security headers
- Non-root user in Docker container
- CORS enabled
- Request logging
- Input validation
- Error handling

## Container Health Check

The Docker image includes a health check that runs every 30 seconds:
```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', ...)"
```

This is used by both Docker and ECS to monitor container health.
