const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const winston = require('winston');
const expressWinston = require('express-winston');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 8080;
const NODE_ENV = process.env.NODE_ENV || 'development';

const logger = winston.createLogger({
  level: NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: {
    service: 'ecspresso-bedrock-review-app',
    environment: NODE_ENV,
    region: process.env.AWS_REGION || 'unknown',
    hostname: require('os').hostname(),
  },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    }),
  ],
});

app.use((req, res, next) => {
  req.id = uuidv4();
  res.setHeader('X-Request-ID', req.id);
  next();
});

app.use(helmet());
app.use(cors());

app.use(
  expressWinston.logger({
    winstonInstance: logger,
    meta: true,
    msg: 'HTTP {{req.method}} {{req.url}}',
    expressFormat: false,
    colorize: false,
    dynamicMeta: (req, res) => ({
      requestId: req.id,
      ip: req.ip || req.connection.remoteAddress,
      userAgent: req.get('user-agent'),
      responseTime: res.get('X-Response-Time'),
    }),
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint (for ALB target group health checks)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to ecspresso-bedrock-review-app',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      api: '/api/v1',
    },
  });
});

app.get('/api/v1/items', (req, res) => {
  const items = [
    { id: 1, name: 'Item 1', description: 'Sample item 1' },
    { id: 2, name: 'Item 2', description: 'Sample item 2' },
    { id: 3, name: 'Item 3', description: 'Sample item 3' },
  ];
  res.json({
    success: true,
    data: items,
    count: items.length,
  });
});

app.get('/api/v1/items/:id', (req, res) => {
  const { id } = req.params;
  const item = {
    id: parseInt(id, 10),
    name: `Item ${id}`,
    description: `Sample item ${id}`,
  };
  res.json({
    success: true,
    data: item,
  });
});

app.post('/api/v1/items', (req, res) => {
  const { name, description } = req.body;
  const newItem = {
    id: Date.now(),
    name: name || 'New Item',
    description: description || 'New sample item',
    createdAt: new Date().toISOString(),
  };
  res.status(201).json({
    success: true,
    data: newItem,
  });
});

app.get('/api/v1/info', (req, res) => {
  res.json({
    success: true,
    data: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      hostname: require('os').hostname(),
      environment: process.env.NODE_ENV || 'development',
      region: process.env.AWS_REGION || 'not set',
      availabilityZone: process.env.AWS_AVAILABILITY_ZONE || 'not set',
    },
  });
});

// demo/inject-risky-change.js inserts intentionally risky endpoints directly
// above this marker, to exercise the Agentic Review gate end-to-end. See
// demo/README.md. Do not remove this comment.
// DEMO_INJECTION_POINT
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.path,
  });
});

app.use(
  expressWinston.errorLogger({
    winstonInstance: logger,
    meta: true,
    dynamicMeta: (req, res) => ({
      requestId: req.id,
      ip: req.ip || req.connection.remoteAddress,
    }),
  })
);

app.use((err, req, res, next) => {
  logger.error('Request error', {
    requestId: req.id,
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    statusCode: err.status || 500,
  });

  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal server error',
    requestId: req.id,
  });
});

/* istanbul ignore next -- exercised only when run as the server entrypoint, not under test */
if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info('Server started', {
      port: PORT,
      environment: NODE_ENV,
      healthCheck: `http://localhost:${PORT}/health`,
    });
  });

  process.on('SIGTERM', () => {
    logger.info('SIGTERM signal received: closing HTTP server');
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
  });
}

module.exports = app;
