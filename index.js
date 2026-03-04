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

const sleep = (seconds, milliseconds = false) => {
  const delay = milliseconds ? seconds : seconds * 1000;
  return new Promise(resolve => setTimeout(resolve, delay));
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

// Test endpoints
app.post('/api/send-and-sync', (req, res) => messageController.sendAndSync(req, res));
app.get('/api/status/:messageId', (req, res) => messageController.getStatus(req, res));

// Tall Bob test endpoint
app.get('/test/tallbob', async (req, res) => {
  console.log('🧪 Running Tall Bob connection test...');
  console.log('Using API Username:', process.env.TALLBOB_API_USERNAME);
  console.log('API Key length:', process.env.TALLBOB_API_KEY?.length);
  console.log('Base URL:', tallbobService.baseURL);

  try {
    await tallbobService.createWebhook()
    await sleep(5)
  } catch (error) {
    console.log(error)
  }
  
  
  try {
    const smsResult = await tallbobService.sendSMS({
      to: '61499000100',
      from: 'TestSender',
      message: 'Tall Bob integration test message',
      reference: `test_${Date.now()}`
    });

    let statusResult = null;
    if (smsResult && smsResult.messageId) {
      console.log('\n--- Getting message status ---');
      statusResult = await tallbobService.getMessageStatus(smsResult.messageId);
    }

    let mmsResult = null;
    try {
      console.log('\n--- Testing MMS ---');
      mmsResult = await tallbobService.sendMMS({
        to: '61499000100',
        from: 'TestSender',
        message: 'Test MMS message',
        mediaUrl: 'https://via.placeholder.com/150',
        reference: `test_mms_${Date.now()}`
      });
    } catch (mmsError) {
      mmsResult = { error: mmsError.message, note: 'MMS test failed' };
    }

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      tests: {
        sms: { success: true, data: smsResult },
        status: statusResult ? { success: true, data: statusResult } : { success: false },
        mms: mmsResult ? { success: !mmsResult.error, data: mmsResult } : { success: false }
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

// Debug GHL client structure
app.get('/test/ghl/debug', async (req, res) => {
  console.log('🔍 Debugging GHL client structure...');
  
  const debug = {
    clientExists: !!ghlClient,
    methods: [],
    availableProperties: []
  };

  if (ghlClient) {
    // List all top-level properties/methods
    debug.availableProperties = Object.getOwnPropertyNames(ghlClient)
      .filter(name => !name.startsWith('_'));
    
    // Try to find locations-related methods
    const locationMethods = [];
    for (const key of Object.keys(ghlClient)) {
      if (typeof ghlClient[key] === 'object' && ghlClient[key] !== null) {
        debug.methods.push({
          section: key,
          methods: Object.getOwnPropertyNames(ghlClient[key])
            .filter(m => typeof ghlClient[key][m] === 'function')
        });
      }
    }
  }

  res.json({
    success: true,
    debug
  });
});


// GHL test endpoint
app.get('/test/ghl', async (req, res) => {
  console.log('🧪 Running GoHighLevel connection test...');
  console.log('GHL Token length:', process.env.GHL_PRIVATE_INTEGRATION_TOKEN?.length);
  
  const results = {
    timestamp: new Date().toISOString(),
    tests: {}
  };

  try {
    // Test 1: Get locations (basic connectivity test)
    console.log('\n--- Test 1: Fetching locations ---');
    const locations = await ghlService.getLocations();
    results.tests.locations = {
      success: true,
      count: locations?.length || 0,
      firstLocationId: locations?.[0]?.id || null
    };
    console.log(`✅ Found ${locations?.length || 0} locations`);

    // Test 2: Create a test contact
    console.log('\n--- Test 2: Creating test contact ---');
    const testPhone = '+15555550001'; // Use a test phone number
    const locationId = locations?.[0]?.id;
    
    if (locationId) {
      const { contact, action } = await ghlService.upsertContact({
        phone: testPhone,
        firstName: 'Test',
        lastName: 'User',
        email: 'test@example.com',
        tags: ['test_contact', 'api_test'],
        customFields: [
          { key: 'test_timestamp', value: new Date().toISOString() }
        ]
      }, locationId);
      
      results.tests.contact = {
        success: true,
        contactId: contact.id,
        action: action
      };
      console.log(`✅ Contact ${action}: ${contact.id}`);

      // Test 3: Create a conversation
      console.log('\n--- Test 3: Creating conversation ---');
      const conversation = await ghlService.createConversation({
        contactId: contact.id,
        locationId: locationId,
        type: 'SMS'
      });
      
      results.tests.conversation = {
        success: true,
        conversationId: conversation.id
      };
      console.log(`✅ Conversation created: ${conversation.id}`);

      // Test 4: Add a test message
      console.log('\n--- Test 4: Adding test message ---');
      const message = await ghlService.addMessageToConversation(conversation.id, {
        body: 'This is a test message from the integration',
        messageType: 'SMS',
        direction: 'outbound',
        date: new Date().toISOString()
      });
      
      results.tests.message = {
        success: true,
        messageId: message.id
      };
      console.log(`✅ Message added: ${message.id}`);

      // Test 5: Search for the contact
      console.log('\n--- Test 5: Searching contacts ---');
      const searchResults = await ghlService.searchContactsByPhone(testPhone, locationId);
      results.tests.search = {
        success: true,
        foundCount: searchResults?.length || 0
      };
      console.log(`✅ Found ${searchResults?.length || 0} contacts`);

      // Test 6: Add to campaign (optional - uncomment if you have a test campaign)
      // console.log('\n--- Test 6: Adding to campaign ---');
      // const campaignResult = await ghlService.addToCampaign(contact.id, 'your_test_campaign_id', locationId);
      // results.tests.campaign = { success: true };
    }

    res.json({
      success: true,
      message: 'GHL integration test completed',
      results
    });

  } catch (error) {
    console.error('❌ GHL test failed:', error);
    res.status(500).json({
      success: false,
      timestamp: new Date().toISOString(),
      error: error.message,
      details: error.response?.data || null
    });
  }
});

// Simple GHL connection test (lightweight)
app.get('/test/ghl/ping', async (req, res) => {
  try {
    const locations = await ghlService.getLocations();
    res.json({
      success: true,
      message: 'GHL connection successful',
      locationCount: locations?.length || 0,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Clean up test contacts (optional - run after tests)
app.delete('/test/ghl/cleanup/:contactId', async (req, res) => {
  const { contactId } = req.params;
  const { locationId } = req.query;
  
  try {
    // Note: GHL API might not allow direct contact deletion
    // You might need to archive or update instead
    res.json({
      success: true,
      message: `Cleanup endpoint - would delete/archive contact ${contactId}`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
// Routes
routes(app, tallbobService, ghlService, messageController)

app.use(express.static('dist'))

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err.stack);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ============================================
// HTTPS SERVER WITH PEM FILES (FIXED FILENAMES)
// ============================================
const HTTP_PORT = process.env.PORT || 80;
const HTTPS_PORT = 443;
const certDir = 'C:\\certificates\\';

// Paths to your PEM files (using your actual filenames)
const certPath = path.join(certDir, 'cayked.store-crt.pem');
const keyPath = path.join(certDir, 'cayked.store-key.pem');
const chainPath = path.join(certDir, 'cayked.store-chain.pem');

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
    console.log('\n🔐 Found SSL certificates, starting HTTPS server...');
    console.log('📁 Using:');
    console.log(`   - Cert: ${path.basename(certPath)}`);
    console.log(`   - Key: ${path.basename(keyPath)}`);
    
    const httpsOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };
    
    // Add chain if it exists
    if (fs.existsSync(chainPath)) {
      httpsOptions.ca = fs.readFileSync(chainPath);
      console.log(`   - Chain: ${path.basename(chainPath)}`);
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
  console.log(`\n❌ Certificate files not found in: ${certDir}`);
  console.log('📁 Expected files:');
  console.log(`   - ${path.basename(certPath)} (exists: ${fs.existsSync(certPath)})`);
  console.log(`   - ${path.basename(keyPath)} (exists: ${fs.existsSync(keyPath)})`);
  
  // List what's actually there
  try {
    console.log('\n📋 Your actual files:');
    const files = fs.readdirSync(certDir);
    files.forEach(file => {
      if (file.includes('cayked.store')) {
        console.log(`   - ${file}`);
      }
    });
  } catch (e) {
    console.log('   (Could not read directory)');
  }
  
  console.log('\n✅ Starting HTTP server as fallback...');
  startHttpServer();
}