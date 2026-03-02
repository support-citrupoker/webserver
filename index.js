import 'dotenv/config'
import morgan from 'morgan'
import express from 'express'
import compression from 'compression'
import helmet from 'helmet'
import http from 'http'
import https from 'https'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import cors from 'cors'
import { HighLevel } from '@gohighlevel/api-client';
import TallBobService from './services/tallbob.service.js';
import GHLService from './services/ghl.service.js';
import webhookRoutes from './routes/webhooks.js';
import MessageController from './controllers/message.controller.js';
import routes from './routes/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
global.__basedir = __dirname

// Validate environment variables
const requiredEnvVars = [
  'GHL_PRIVATE_INTEGRATION_TOKEN',
  'TALLBOB_API_KEY',
  'TALLBOB_API_URL'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// Initialize clients
const ghlClient = new HighLevel({
  privateIntegrationToken: process.env.GHL_PRIVATE_INTEGRATION_TOKEN,
  apiVersion: process.env.GHL_API_VERSION || '2021-07-28'
})

const tallbobService = new TallBobService()
const ghlService = new GHLService(ghlClient)

// Initialize controller with services
const messageController = new MessageController(tallbobService, ghlService);
const app = express()

// Middleware
app.use(compression())
app.use(express.urlencoded({ extended: true }))
app.use(express.json())
app.use(cors({ origin: true, credentials: true }))
app.use(morgan('combined'))
app.use(helmet({
  contentSecurityPolicy: true
}))

// Your routes
app.post('/api/send-and-sync', (req, res) => messageController.sendAndSync(req, res));
app.get('/api/status/:messageId', (req, res) => messageController.getStatus(req, res));
app.get('/test/tallbob', async (req, res) => {
  // ... your test code (keep as is)
});

routes(app)
app.use('/webhooks', webhookRoutes(tallbobService, ghlService, messageController));
app.use(express.static('dist'))

// Error handling
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err.stack);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ============================================
// HTTPS SERVER WITH PEM FILES (NO ENCRYPTION ISSUES)
// ============================================
const HTTP_PORT = process.env.PORT || 3000;
const HTTPS_PORT = 443;
const certDir = 'C:\\certificates\\';

// Paths to your PEM files
const certPath = path.join(certDir, 'cayked.store.crt.pem');
const keyPath = path.join(certDir, 'cayked.store.key.pem');
const chainPath = path.join(certDir, 'cayked.store.chain.pem');

// Function to start HTTP server (fallback)
function startHttpServer() {
  http.createServer(app).listen(HTTP_PORT, () => {
    console.log(`✅ HTTP Server running on port ${HTTP_PORT}`);
    console.log(`📱 Tall Bob service: ${tallbobService.baseURL}`);
    console.log(`📊 GHL service: configured`);
  });
}

// Check if certificate files exist
if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  try {
    console.log('🔐 Found SSL certificates, starting HTTPS server...');
    
    const httpsOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };
    
    // Add chain if it exists (optional)
    if (fs.existsSync(chainPath)) {
      httpsOptions.ca = fs.readFileSync(chainPath);
    }

    // Start HTTPS server
    https.createServer(httpsOptions, app).listen(HTTPS_PORT, () => {
      console.log(`✅ HTTPS Server running on port ${HTTPS_PORT}`);
      console.log(`🔒 Secure access: https://cayked.store`);
      console.log(`🔒 Secure access: https://www.cayked.store`);
    });

    // Redirect HTTP to HTTPS
    http.createServer((req, res) => {
      const host = req.headers.host?.split(':')[0] || 'cayked.store';
      res.writeHead(301, { Location: `https://${host}${req.url}` });
      res.end();
    }).listen(HTTP_PORT, () => {
      console.log(`↪️ HTTP on port ${HTTP_PORT} redirecting to HTTPS`);
      console.log(`📱 Tall Bob service: ${tallbobService.baseURL}`);
      console.log(`📊 GHL service: configured`);
    });

  } catch (err) {
    console.error('❌ Failed to start HTTPS server:', err.message);
    console.log('⚠️ Falling back to HTTP only');
    startHttpServer();
  }
} else {
  console.log(`⚠️ SSL certificates not found in: ${certDir}`);
  console.log('📁 Expected files:');
  console.log(`   - ${certPath}`);
  console.log(`   - ${keyPath}`);
  console.log('💡 Run win-acme first to generate PEM files');
  startHttpServer();
}