import 'dotenv/config'
import morgan from 'morgan'
import mongoose from 'mongoose'
import express from 'express'
import compression from 'compression'
import helmet from 'helmet'
import http from 'http'
import https from 'https' // ADD THIS
import Greenlock from 'greenlock' // ADD THIS
import acmeDnsCli from 'acme-dns-01-cli' // ADD THIS
import routes from './routes/index.js'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import cors from 'cors'
import { HighLevel } from '@gohighlevel/api-client';
import TallBobService from './services/tallbob.service.js';
import greenlockStoreFs from 'greenlock-store-fs';
import GHLService from './services/ghl.service.js';
import webhookRoutes from './routes/webhooks.js';
import MessageController from './controllers/message.controller.js';
import fs from 'fs' // ADD THIS for file operations
import path from 'path' // ADD THIS for path handling

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
global.__basedir = __dirname

// Validate environment variables
const requiredEnvVars = [
  'GHL_PRIVATE_INTEGRATION_TOKEN',
  'TALLBOB_API_KEY',
  'TALLBOB_API_URL'
];

// Add SSL/Greenlock environment variables (optional but recommended)
const sslEnvVars = [
  'SSL_DOMAIN', // Your domain (e.g., example.com)
  'SSL_EMAIL'   // Your email for Let's Encrypt notifications
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// Check SSL environment variables but don't exit if missing (will use HTTP fallback)
for (const envVar of sslEnvVars) {
  if (!process.env[envVar]) {
    console.warn(`⚠️ Warning: ${envVar} not set. HTTPS will not be available.`);
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

// Add a test endpoint for the controller
app.post('/api/send-and-sync', (req, res) => messageController.sendAndSync(req, res));
app.get('/api/status/:messageId', (req, res) => messageController.getStatus(req, res));
app.get('/test/tallbob', async (req, res) => {

  console.log('🧪 Running Tall Bob connection test...');
  console.log('Using API Username:', process.env.TALLBOB_API_USERNAME);
  console.log('API Key length:', process.env.TALLBOB_API_KEY?.length);
  console.log('Base URL:', tallbobService.baseURL);
  
  try {
    // Test 1: Basic connection
    console.log('\n--- Test 1: Sending test SMS ---');
    const smsResult = await tallbobService.sendSMS({
      to: '61499000100', // Test number from docs
      from: 'TestSender',
      message: 'Tall Bob integration test message',
      reference: `test_${Date.now()}`
    });

    // Test 2: Get message status (if we got a message ID)
    let statusResult = null;
    if (smsResult && smsResult.messageId) {
      console.log('\n--- Test 2: Getting message status ---');
      statusResult = await tallbobService.getMessageStatus(smsResult.messageId);
    }

    // Test 3: Test MMS (optional, will likely fail if no media URL)
    let mmsResult = null;
    try {
      console.log('\n--- Test 3: Testing MMS (optional) ---');
      mmsResult = await tallbobService.sendMMS({
        to: '61499000100',
        from: 'TestSender',
        message: 'Test MMS message',
        mediaUrl: 'https://via.placeholder.com/150', // Placeholder image
        reference: `test_mms_${Date.now()}`
      });
    } catch (mmsError) {
      mmsResult = { error: mmsError.message, note: 'MMS test failed - may require valid media URL' };
    }

    // Return all test results
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      tests: {
        sms: {
          success: true,
          data: smsResult
        },
        status: statusResult ? {
          success: true,
          data: statusResult
        } : {
          success: false,
          note: 'No message ID returned from SMS test'
        },
        mms: mmsResult ? {
          success: !mmsResult.error,
          data: mmsResult
        } : {
          success: false,
          note: 'MMS test skipped'
        }
      }
    });

  } catch (error) {
    console.error('❌ Tall Bob test failed:', error);
    res.status(500).json({
      success: false,
      timestamp: new Date().toISOString(),
      error: error.message,
      details: error.response?.data || null
    });
  }
})

routes(app)

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err.stack);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});


app.use(compression())
app.use(express.urlencoded({ extended: true }))
app.use(express.json())
app.use(cors({ origin: true, credentials: true }))
app.use(morgan('combined'))
app.use(helmet({
  contentSecurityPolicy: true
}))

// Routes
app.use('/webhooks', webhookRoutes(tallbobService, ghlService, messageController));
app.use(express.static('dist'))

const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 443;

// Function to create HTTP server (fallback)
function createHttpServer() {
  http.createServer(app).listen(PORT, () => {
    console.log(`✅ HTTP Server running on port ${PORT}`);
    console.log(`📱 Tall Bob service: ${tallbobService.baseURL}`);
    console.log(`📊 GHL service: configured`);
  });
}

if (process.env.SSL_DOMAIN && process.env.SSL_EMAIL) {
  console.log('🔐 Setting up Greenlock SSL for domain:', process.env.SSL_DOMAIN);
  
  // Create DNS challenge plugin
  const dnsChallenge = acmeDnsCli.create({
    debug: true,
    dnsServers: ['8.8.8.8', '1.1.1.1'],
    waitFor: 120
  });
  
  // Create Greenlock instance
  const greenlock = Greenlock.create({
    version: 'draft-12',
    server: process.env.ACME_DIRECTORY_URL || 'https://acme-v02.api.letsencrypt.org/directory',
    email: process.env.SSL_EMAIL,
    agreeTos: true,
    configDir: path.join(__dirname, 'greenlock.d'),
    challenges: { 'dns-01': dnsChallenge },
    challengeType: 'dns-01',
    approveDomains: [process.env.SSL_DOMAIN, `www.${process.env.SSL_DOMAIN}`]
  });

  let httpsReady = false;
  
  // Start HTTPS setup in background
  (async () => {
    try {
      console.log('⏳ Obtaining certificates...');
      
      // Check if we already have certificates
      const certs = await greenlock.getCertificates({ servername: process.env.SSL_DOMAIN });
      
      if (certs && certs.privateKey && certs.cert) {
        console.log('✅ Certificates obtained');
        
        // Create HTTPS server
        https.createServer(greenlock.tlsOptions, app).listen(HTTPS_PORT, () => {
          httpsReady = true;
          console.log(`✅ HTTPS Server running on port ${HTTPS_PORT}`);
          console.log(`🔒 Secure access: https://${process.env.SSL_DOMAIN}`);
        });
      } else {
        console.log('⚠️ Certificates not ready yet. Will retry in 60 seconds...');
        // Retry after 60 seconds
        setTimeout(() => {
          console.log('🔄 Retrying certificate acquisition...');
          // Reload the process or handle retry logic
        }, 60000);
      }
    } catch (err) {
      console.error('❌ HTTPS setup failed:', err.message);
      if (err.message.includes('DNS')) {
        console.log('📝 DNS issue detected. Make sure TXT records are added and propagated.');
      }
    }
  })();

  // HTTP server with error handling
  const httpServer = http.createServer((req, res) => {
    if (httpsReady && process.env.REDIRECT_HTTP_TO_HTTPS === 'true') {
      const host = req.headers.host?.split(':')[0] || process.env.SSL_DOMAIN;
      res.writeHead(301, { Location: `https://${host}${req.url}` });
      res.end();
    } else {
      app(req, res);
    }
  });

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ Port ${PORT} is already in use.`);
      console.log('💡 Run these commands to fix:');
      console.log(`   netstat -ano | findstr :${PORT}`);
      console.log('   taskkill /PID [PID] /F');
      process.exit(1);
    } else {
      console.error('HTTP server error:', err);
    }
  });

  httpServer.listen(PORT, () => {
    console.log(`📡 HTTP server on port ${PORT}`);
  });
  
} else {
  createHttpServer();
}