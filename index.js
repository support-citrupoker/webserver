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

// In index.js - Test the SDK-based service
// Comprehensive GHL Service Test
app.get('/test/ghl-full', async (req, res) => {
  console.log('\n🧪 ========== TESTING GHL SERVICE ==========');
  
  const results = {
    timestamp: new Date().toISOString(),
    locationId: ghlService.locationId,
    tests: {}
  };

  try {
    // ========== TEST 1: SEARCH CONTACT ==========
    console.log('\n📋 TEST 1: Search contact by phone');
    try {
      const testPhone = '+237652251848';
      const searchResult = await ghlService.searchContactsByPhone(testPhone);
      results.tests.searchContact = {
        success: true,
        method: 'searchContactsByPhone()',
        found: searchResult.length,
        contacts: searchResult
      };
      console.log(`✅ Search completed - Found: ${searchResult.length}`);
    } catch (error) {
      results.tests.searchContact = {
        success: false,
        method: 'searchContactsByPhone()',
        error: error.message
      };
      console.log(`❌ Search failed: ${error.message}`);
    }

    // ========== TEST 2: CREATE CONTACT ==========
    console.log('\n📋 TEST 2: Create new contact');
    try {
      const uniqueId = Date.now();
      const contactData = {
        firstName: 'Test',
        lastName: `User_${uniqueId}`,
        email: `test.${uniqueId}@example.com`,
        phone: '+237652251848',
        tags: ['test_contact', 'automated_test'],
        source: 'GHL Full Test',
        address1: '123 Test Street',
        city: 'Test City',
        state: 'TS',
        postalCode: '12345',
        country: 'US'
      };
      
      const createResult = await ghlService.createContact(contactData);
      results.tests.createContact = {
        success: true,
        method: 'createContact()',
        contactId: createResult.id,
        contact: createResult
      };
      console.log(`✅ Contact created with ID: ${createResult.id}`);
      
      // Store contact ID for subsequent tests
      const testContactId = createResult.id;

      // ========== TEST 3: GET CONTACT ==========
      console.log('\n📋 TEST 3: Get contact by ID');
      try {
        const getResult = await ghlService.getContact(testContactId);
        results.tests.getContact = {
          success: true,
          method: 'getContact()',
          contact: getResult
        };
        console.log(`✅ Got contact: ${getResult.id}`);
      } catch (error) {
        results.tests.getContact = {
          success: false,
          method: 'getContact()',
          error: error.message
        };
        console.log(`❌ Get contact failed: ${error.message}`);
      }

      // ========== TEST 4: UPDATE CONTACT ==========
      console.log('\n📋 TEST 4: Update contact');
      try {
        const updateData = {
          firstName: 'Updated',
          lastName: `Name_${uniqueId}`,
          tags: ['updated_tag', 'test_updated']
        };
        
        const updateResult = await ghlService.updateContact(testContactId, updateData);
        results.tests.updateContact = {
          success: true,
          method: 'updateContact()',
          contact: updateResult
        };
        console.log(`✅ Contact updated: ${updateResult.id}`);
      } catch (error) {
        results.tests.updateContact = {
          success: false,
          method: 'updateContact()',
          error: error.message
        };
        console.log(`❌ Update contact failed: ${error.message}`);
      }

      // ========== TEST 5: ADD TAG ==========
      console.log('\n📋 TEST 5: Add tag to contact');
      try {
        const tagResult = await ghlService.addTagToContact(testContactId, 'test_tag_1');
        results.tests.addTag = {
          success: true,
          method: 'addTagToContact()',
          result: tagResult
        };
        console.log(`✅ Tag added`);
      } catch (error) {
        results.tests.addTag = {
          success: false,
          method: 'addTagToContact()',
          error: error.message
        };
        console.log(`❌ Add tag failed: ${error.message}`);
      }

      // ========== TEST 6: ADD ANOTHER TAG ==========
      console.log('\n📋 TEST 6: Add second tag');
      try {
        const tagResult = await ghlService.addTagToContact(testContactId, 'test_tag_2');
        results.tests.addTag2 = {
          success: true,
          method: 'addTagToContact()',
          result: tagResult
        };
        console.log(`✅ Second tag added`);
      } catch (error) {
        results.tests.addTag2 = {
          success: false,
          method: 'addTagToContact()',
          error: error.message
        };
        console.log(`❌ Add second tag failed: ${error.message}`);
      }

      // ========== TEST 7: ADD NOTE ==========
      console.log('\n📋 TEST 7: Add note to contact');
      try {
        const noteResult = await ghlService.addNote(
          testContactId, 
          'This is a test note from the GHL full test'
        );
        results.tests.addNote = {
          success: true,
          method: 'addNote()',
          result: noteResult
        };
        console.log(`✅ Note added`);
      } catch (error) {
        results.tests.addNote = {
          success: false,
          method: 'addNote()',
          error: error.message
        };
        console.log(`❌ Add note failed: ${error.message}`);
      }

      // ========== TEST 8: GET NOTES ==========
      console.log('\n📋 TEST 8: Get contact notes');
      try {
        const notes = await ghlService.getNotes(testContactId);
        results.tests.getNotes = {
          success: true,
          method: 'getNotes()',
          count: notes.length,
          notes: notes
        };
        console.log(`✅ Got ${notes.length} notes`);
      } catch (error) {
        results.tests.getNotes = {
          success: false,
          method: 'getNotes()',
          error: error.message
        };
        console.log(`❌ Get notes failed: ${error.message}`);
      }

      // ========== TEST 9: CREATE CONVERSATION ==========
      console.log('\n📋 TEST 9: Create conversation');
      try {
        const conversation = await ghlService.createConversation(testContactId, 'SMS');
        results.tests.createConversation = {
          success: true,
          method: 'createConversation()',
          conversationId: conversation.id,
          conversation: conversation
        };
        console.log(`✅ Conversation created: ${conversation.id}`);
        
        const testConversationId = conversation.id;

        // ========== TEST 10: ADD MESSAGE ==========
        console.log('\n📋 TEST 10: Add message to conversation');
        try {
          const messageData = {
            body: 'This is a test message from the GHL full test',
            messageType: 'SMS',
            direction: 'outbound',
            date: new Date().toISOString()
          };
          
          const message = await ghlService.addMessageToConversation(testConversationId, messageData);
          results.tests.addMessage = {
            success: true,
            method: 'addMessageToConversation()',
            messageId: message.id,
            message: message
          };
          console.log(`✅ Message added: ${message.id}`);
        } catch (error) {
          results.tests.addMessage = {
            success: false,
            method: 'addMessageToConversation()',
            error: error.message
          };
          console.log(`❌ Add message failed: ${error.message}`);
        }

        // ========== TEST 11: GET CONVERSATION MESSAGES ==========
        console.log('\n📋 TEST 11: Get conversation messages');
        try {
          const messages = await ghlService.getConversationMessages(testConversationId);
          results.tests.getMessages = {
            success: true,
            method: 'getConversationMessages()',
            count: messages.length,
            messages: messages
          };
          console.log(`✅ Got ${messages.length} messages`);
        } catch (error) {
          results.tests.getMessages = {
            success: false,
            method: 'getConversationMessages()',
            error: error.message
          };
          console.log(`❌ Get messages failed: ${error.message}`);
        }

      } catch (error) {
        results.tests.createConversation = {
          success: false,
          method: 'createConversation()',
          error: error.message
        };
        console.log(`❌ Create conversation failed: ${error.message}`);
      }

      // ========== TEST 12: UPDATE CUSTOM FIELD ==========
      console.log('\n📋 TEST 12: Update custom field');
      try {
        const customFieldResult = await ghlService.updateCustomField(
          testContactId,
          'test_field',
          'Test Value ' + Date.now()
        );
        results.tests.updateCustomField = {
          success: true,
          method: 'updateCustomField()',
          result: customFieldResult
        };
        console.log(`✅ Custom field updated`);
      } catch (error) {
        results.tests.updateCustomField = {
          success: false,
          method: 'updateCustomField()',
          error: error.message
        };
        console.log(`❌ Update custom field failed: ${error.message}`);
      }

      // ========== TEST 13: REMOVE TAG ==========
      console.log('\n📋 TEST 13: Remove tag from contact');
      try {
        const removeResult = await ghlService.removeTagFromContact(testContactId, 'test_tag_1');
        results.tests.removeTag = {
          success: true,
          method: 'removeTagFromContact()',
          result: removeResult
        };
        console.log(`✅ Tag removed`);
      } catch (error) {
        results.tests.removeTag = {
          success: false,
          method: 'removeTagFromContact()',
          error: error.message
        };
        console.log(`❌ Remove tag failed: ${error.message}`);
      }

    } catch (error) {
      results.tests.createContact = {
        success: false,
        method: 'createContact()',
        error: error.message
      };
      console.log(`❌ Create contact failed - skipping dependent tests`);
    }

    // ========== TEST 14: UPSERT CONTACT ==========
    console.log('\n📋 TEST 14: Upsert contact (should update existing)');
    try {
      const upsertData = {
        firstName: 'Upserted',
        lastName: 'Name',
        phone: '+237652251848',
        tags: ['upsert_test', 'existing_contact'],
        source: 'Upsert Test'
      };
      
      const upsertResult = await ghlService.upsertContact(upsertData);
      results.tests.upsertContact = {
        success: true,
        method: 'upsertContact()',
        action: upsertResult.action,
        contactId: upsertResult.contact.id,
        contact: upsertResult.contact
      };
      console.log(`✅ Upsert completed - Action: ${upsertResult.action}`);
    } catch (error) {
      results.tests.upsertContact = {
        success: false,
        method: 'upsertContact()',
        error: error.message
      };
      console.log(`❌ Upsert failed: ${error.message}`);
    }

    // ========== TEST 15: TEST CONNECTION ==========
    console.log('\n📋 TEST 15: Test connection');
    try {
      const connectionResult = await ghlService.testConnection();
      results.tests.testConnection = {
        success: true,
        method: 'testConnection()',
        result: connectionResult
      };
      console.log(`✅ Connection test passed`);
    } catch (error) {
      results.tests.testConnection = {
        success: false,
        method: 'testConnection()',
        error: error.message
      };
      console.log(`❌ Connection test failed: ${error.message}`);
    }

    console.log('\n✅ ========== GHL SERVICE TESTS COMPLETED ==========');
    res.json({
      success: true,
      summary: {
        totalTests: Object.keys(results.tests).length,
        successful: Object.values(results.tests).filter(t => t.success).length,
        failed: Object.values(results.tests).filter(t => !t.success).length
      },
      results
    });

  } catch (error) {
    console.error('❌ Test suite error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      results
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