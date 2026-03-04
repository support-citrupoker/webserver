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

// Test route for adding conversation to existing contact by phone
app.get('/test/add-conversation-to-existing', async (req, res) => {
  try {
    const { phone, message } = req.body;
    
    const testPhone = phone || '+237652251848';
    const testMessage = message || 'This is a test message from the integration';
    
    console.log('\n🧪 ========== TEST: ADD CONVERSATION TO EXISTING CONTACT ==========');
    console.log(`📞 Testing with phone: ${testPhone}`);

    // Step 1: Check if phone exists using the duplicate error method
    console.log('\n📋 STEP 1: Checking if phone exists...');
    const phoneCheck = await ghlService.phoneExists(testPhone);
    
    if (!phoneCheck.exists) {
      return res.json({
        success: false,
        message: 'Phone number does not exist. Please create a contact first.',
        phoneCheck
      });
    }

    console.log(`✅ Phone exists! Contact ID: ${phoneCheck.contactId}`);
    
    // Step 2: Get the full contact details
    console.log('\n📋 STEP 2: Fetching full contact details...');
    const contact = await ghlService.getContact(phoneCheck.contactId);
    console.log(`✅ Contact fetched: ${contact.firstName} ${contact.lastName} (${contact.id})`);

    // Step 3: Create a new conversation for this contact
    console.log('\n📋 STEP 3: Creating new conversation...');
    const conversation = await ghlService.createConversation(
      contact.id,
      'SMS',
      ghlService.locationId
    );
    console.log(`✅ Conversation created: ${conversation.id}`);

    // Step 4: Add a message to the conversation
    console.log('\n📋 STEP 4: Adding message to conversation...');
    const messageData = {
      body: testMessage,
      messageType: 'SMS',
      direction: 'inbound',
      date: new Date().toISOString()
    };
    
    const addedMessage = await ghlService.addMessageToConversation(
      conversation.id,
      messageData,
      ghlService.locationId
    );
    console.log(`✅ Message added: ${addedMessage.id}`);

    // Step 5: Add a tag to track this test
    console.log('\n📋 STEP 5: Adding test tag...');
    await ghlService.addTagToContact(
      contact.id,
      'conversation_test',
      ghlService.locationId
    );
    console.log(`✅ Tag added`);

    // Step 6: Add a note about this test
    console.log('\n📋 STEP 6: Adding test note...');
    await ghlService.addNote(
      contact.id,
      `Test conversation added via API at ${new Date().toISOString()}`,
      ghlService.locationId
    );
    console.log(`✅ Note added`);

    console.log('\n✅ ========== TEST COMPLETED SUCCESSFULLY ==========');

    res.json({
      success: true,
      message: 'Successfully added conversation to existing contact',
      data: {
        phoneCheck,
        contact: {
          id: contact.id,
          name: `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
          phone: contact.phone,
          email: contact.email
        },
        conversation: {
          id: conversation.id,
          type: conversation.type
        },
        message: {
          id: addedMessage.id,
          body: addedMessage.body,
          direction: addedMessage.direction
        }
      }
    });

  } catch (error) {
    console.error('❌ Test failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data
    });
  }
});

// Alternative: Test route that creates a contact if it doesn't exist
app.get('/test/ensure-contact-and-conversation', async (req, res) => {
  try {
    const { phone, firstName, lastName, message } = req.body;
    
    const testPhone = phone || '+237652251848';
    const testFirstName = firstName || 'Test';
    const testLastName = lastName || `User_${Date.now()}`;
    const testMessage = message || 'Welcome message from integration';
    
    console.log('\n🧪 ========== TEST: ENSURE CONTACT AND ADD CONVERSATION ==========');
    console.log(`📞 Testing with phone: ${testPhone}`);

    // Step 1: Try to upsert the contact (will create or update)
    console.log('\n📋 STEP 1: Upserting contact...');
    const { contact, action } = await ghlService.upsertContact({
      firstName: testFirstName,
      lastName: testLastName,
      phone: testPhone,
      email: `test.${Date.now()}@example.com`,
      tags: ['auto_created', 'test_contact'],
      source: 'Test Route'
    });
    
    console.log(`✅ Contact ${action}: ${contact.id}`);

    // Step 2: Create a new conversation
    console.log('\n📋 STEP 2: Creating new conversation...');
    const conversation = await ghlService.createConversation(
      contact.id,
      'SMS',
      ghlService.locationId
    );
    console.log(`✅ Conversation created: ${conversation.id}`);

    // Step 3: Add a welcome message
    console.log('\n📋 STEP 3: Adding message to conversation...');
    const messageData = {
      body: testMessage,
      messageType: 'SMS',
      direction: 'outbound',
      date: new Date().toISOString()
    };
    
    const addedMessage = await ghlService.addMessageToConversation(
      conversation.id,
      messageData,
      ghlService.locationId
    );
    console.log(`✅ Message added: ${addedMessage.id}`);

    // Step 4: If contact was newly created, add a special note
    if (action === 'created') {
      console.log('\n📋 STEP 4: Adding welcome note for new contact...');
      await ghlService.addNote(
        contact.id,
        `New contact created via API at ${new Date().toISOString()}`,
        ghlService.locationId
      );
      console.log(`✅ Welcome note added`);
    }

    console.log('\n✅ ========== TEST COMPLETED SUCCESSFULLY ==========');

    res.json({
      success: true,
      message: `Contact ${action} and conversation created`,
      data: {
        action,
        contact: {
          id: contact.id,
          name: `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
          phone: contact.phone,
          email: contact.email
        },
        conversation: {
          id: conversation.id,
          type: conversation.type
        },
        message: {
          id: addedMessage.id,
          body: addedMessage.body
        }
      }
    });

  } catch (error) {
    console.error('❌ Test failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data
    });
  }
});

// Test route to just check if a phone exists
app.get('/test/check-phone/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    
    console.log(`\n📞 Checking phone: ${phone}`);
    
    const result = await ghlService.phoneExists(phone);
    
    if (result.exists) {
      // Get the full contact details
      const contact = await ghlService.getContact(result.contactId);
      
      res.json({
        success: true,
        exists: true,
        message: `Phone number exists`,
        phoneCheck: result,
        contact: {
          id: contact.id,
          name: `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
          phone: contact.phone,
          email: contact.email,
          tags: contact.tags
        }
      });
    } else {
      res.json({
        success: true,
        exists: false,
        message: `Phone number does not exist`,
        phoneCheck: result
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
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