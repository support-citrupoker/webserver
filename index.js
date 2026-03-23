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
import TallBobService from './services/tallbob.service.js'
import GHLService from './services/ghl.service.js'
import CommentTracker from './services/tracker.service.js'
import PollingService from './services/polling.service.js'
import MessageController from './controllers/message.controller.js'
import BlueBubblesService from './services/bluebubblesService.js'
import routes from './routes/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
global.__basedir = __dirname

// Validate environment variables
const requiredEnvVars = [
  'GHL_PRIVATE_INTEGRATION_TOKEN',
  'GHL_LOCATION_ID',
  'TALLBOB_API_USERNAME',
  'TALLBOB_API_KEY'
]

// Optional but recommended for BlueBubbles
const optionalEnvVars = [
  'BLUEBUBBLES_SERVER_URL',
  'BLUEBUBBLES_PASSWORD'
]

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`)
    process.exit(1)
  }
}

// Log optional BlueBubbles status
if (process.env.BLUEBUBBLES_SERVER_URL && process.env.BLUEBUBBLES_PASSWORD) {
  console.log('✅ BlueBubbles configuration found')
} else {
  console.log('⚠️ BlueBubbles not configured (optional)')
}

const sleep = (seconds, milliseconds = false) => {
  const delay = milliseconds ? seconds : seconds * 1000
  return new Promise(resolve => setTimeout(resolve, delay))
}

// Initialize services
const tallbobService = new TallBobService()
const ghlService = new GHLService() // GHLService now handles its own client initialization

// Initialize BlueBubbles (optional)
let bluebubblesService = null
if (process.env.BLUEBUBBLES_SERVER_URL && process.env.BLUEBUBBLES_PASSWORD) {
  bluebubblesService = new BlueBubblesService(
    process.env.BLUEBUBBLES_SERVER_URL,
    process.env.BLUEBUBBLES_PASSWORD
  )
  console.log('📱 BlueBubbles service initialized')
} else {
  console.log('⚠️ BlueBubbles service not initialized (missing config)')
}

// Initialize tracker and polling service
const commentTracker = new CommentTracker()
const pollingService = new PollingService(
  ghlService, 
  tallbobService, 
  commentTracker, 
  bluebubblesService, // Pass BlueBubbles service
  {
    batchSize: 50,
    pollInterval: '*/30 * * * * *',
    syncInterval: '0 */6 * * *'
  }
);

// Initialize controller with services
const messageController = new MessageController(tallbobService, ghlService)

const app = express()

// Middleware
app.use(compression())
app.use(express.urlencoded({ extended: true, limit: '50mb' }))
app.use(express.json({ limit: '50mb' }))
app.use(cors({ origin: true, credentials: true }))
app.use(morgan('combined'))
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}))

// Create webhooks for Tall Bob (with error handling)
try {
  await tallbobService.createWebhooks()
  console.log('✅ Tall Bob webhooks created')
  await sleep(2)
} catch (error) {
  console.error('⚠️ Failed to create Tall Bob webhooks:', error.message)
}

// ==================== TEST ENDPOINTS ====================

app.post('/api/send-and-sync', (req, res) => messageController.sendAndSync(req, res))
app.get('/api/status/:messageId', (req, res) => messageController.getStatus(req, res))

// Polling management endpoints
app.get('/api/polling/status', async (req, res) => {
  const stats = pollingService.getStats()
  const count = await commentTracker.getCount()
  res.json({
    success: true,
    stats: {
      ...stats,
      trackedContacts: count
    }
  })
})

app.post('/api/polling/trigger', async (req, res) => {
  if (pollingService.isPolling) {
    return res.json({ success: false, message: 'Poll already running' })
  }
  
  pollingService.poll().catch(console.error)
  res.json({ success: true, message: 'Poll triggered' })
})

app.post('/api/polling/sync-contacts', async (req, res) => {
  pollingService.syncContacts().catch(console.error)
  res.json({ success: true, message: 'Contact sync triggered' })
})

app.get('/api/polling/contacts', async (req, res) => {
  const contacts = await commentTracker.getContactsToCheck(1000)
  res.json({
    success: true,
    count: contacts.length,
    contacts: contacts.map(c => ({
      contactId: c.contact_id,
      phone: c.phone_number,
      lastChecked: c.last_checked ? new Date(c.last_checked * 1000).toISOString() : null,
      hasHash: !!c.last_comment_hash
    }))
  })
})

// ==================== BLUEBUBBLES TEST ENDPOINTS ====================

if (bluebubblesService) {
  app.get('/test/bluebubbles/status', async (req, res) => {
    try {
      const status = await bluebubblesService.getStatus()
      res.json({
        success: true,
        status: status
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      })
    }
  })

  app.get('/test/bluebubbles/chats', async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit) : 20
      const chats = await bluebubblesService.getChats(limit)
      res.json({
        success: true,
        chats: chats
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      })
    }
  })

  app.post('/test/bluebubbles/send', async (req, res) => {
    try {
      const { to, from, message, effectId } = req.body
      
      if (!to || !from || !message) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: to, from, message'
        })
      }
      
      const result = await bluebubblesService.sendMessage({
        to,
        from,
        message,
        effectId
      })
      
      res.json({
        success: true,
        result: result
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      })
    }
  })
}

// ==================== TALL BOB TEST ENDPOINT ====================

app.get('/test/tallbob', async (req, res) => {
  console.log('🧪 Running Tall Bob connection test...')
  console.log('Using API Username:', process.env.TALLBOB_API_USERNAME)
  console.log('API Key length:', process.env.TALLBOB_API_KEY?.length)
  console.log('Base URL:', tallbobService.baseURL)

  try {
    const smsResult = await tallbobService.sendSMS({
      to: '61499000100',
      from: 'TestSender',
      message: 'Tall Bob integration test message',
      reference: `test_${Date.now()}`
    })

    let statusResult = null
    if (smsResult && smsResult.messageId) {
      console.log('\n--- Getting message status ---')
      statusResult = await tallbobService.getMessageStatus(smsResult.messageId)
    }

    let mmsResult = null
    try {
      console.log('\n--- Testing MMS ---')
      mmsResult = await tallbobService.sendMMS({
        to: '61499000100',
        from: 'TestSender',
        message: 'Test MMS message',
        mediaUrl: 'https://via.placeholder.com/150',
        reference: `test_mms_${Date.now()}`
      })
    } catch (mmsError) {
      mmsResult = { error: mmsError.message, note: 'MMS test failed' }
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
    })

  } catch (error) {
    console.error('❌ Tall Bob test failed:', error)
    res.status(500).json({
      success: false,
      timestamp: new Date().toISOString(),
      error: error.message,
      details: error.response?.data || null
    })
  }
})

// ==================== GHL TEST ENDPOINTS ====================

// Comprehensive GHL Service Test Route
app.get('/test/ghl/comprehensive', async (req, res) => {
  console.log('\n🧪 ========== COMPREHENSIVE GHL SERVICE TEST ==========')
  
  const startTime = Date.now()
  const results = {
    timestamp: new Date().toISOString(),
    locationId: ghlService.locationId,
    tests: {},
    summary: {
      total: 0,
      passed: 0,
      failed: 0
    }
  }

  try {
    // ==================== TEST 1: LOCATION ====================
    console.log('\n📋 TEST 1: Get Location')
    try {
      const location = await ghlService.getLocation()
      results.tests.getLocation = {
        name: 'Get Location',
        success: true,
        data: {
          id: location.id,
          name: location.name,
          phone: location.phone
        }
      }
      results.summary.passed++
      console.log('✅ Get Location successful')
    } catch (error) {
      results.tests.getLocation = {
        name: 'Get Location',
        success: false,
        error: error.message
      }
      results.summary.failed++
      console.log('❌ Get Location failed:', error.message)
    }
    results.summary.total++

    // ==================== TEST 2: CONTACT OPERATIONS ====================
    const testPhone = '+237652251848'
    const uniqueId = Date.now()
    const testEmail = `test.${uniqueId}@example.com`
    
    console.log('\n📋 TEST 2: Check if contact exists')
    try {
      const contactCheck = await ghlService.contactExists(testPhone)
      results.tests.contactExists = {
        name: 'Contact Exists Check',
        success: true,
        data: contactCheck
      }
      results.summary.passed++
      console.log(`✅ Contact exists check: ${contactCheck.exists ? 'Exists' : 'New'}`)
    } catch (error) {
      results.tests.contactExists = {
        name: 'Contact Exists Check',
        success: false,
        error: error.message
      }
      results.summary.failed++
      console.log('❌ Contact exists check failed:', error.message)
    }
    results.summary.total++

    console.log('\n📋 TEST 3: Upsert Contact (Create or Update)')
    let contactId = null
    try {
      const { contact, action } = await ghlService.upsertContact({
        firstName: 'Test',
        lastName: `User_${uniqueId}`,
        phone: testPhone,
        email: testEmail,
        tags: ['test_contact', 'comprehensive_test'],
        source: 'Comprehensive Test',
        address1: '123 Test Street',
        city: 'Test City',
        state: 'TS',
        postalCode: '12345',
        country: 'US',
        customFields: [
          { key: 'test_field', value: `Test value ${uniqueId}` }
        ]
      })
      
      contactId = contact.id
      results.tests.upsertContact = {
        name: 'Upsert Contact',
        success: true,
        data: {
          action,
          contactId: contact.id,
          name: `${contact.firstName} ${contact.lastName}`,
          phone: contact.phone,
          email: contact.email
        }
      }
      results.summary.passed++
      console.log(`✅ Contact ${action}: ${contact.id}`)
    } catch (error) {
      results.tests.upsertContact = {
        name: 'Upsert Contact',
        success: false,
        error: error.message
      }
      results.summary.failed++
      console.log('❌ Upsert Contact failed:', error.message)
    }
    results.summary.total++

    if (contactId) {
      // ==================== TEST 4: GET CONTACT ====================
      console.log('\n📋 TEST 4: Get Contact by ID')
      try {
        const contact = await ghlService.getContact(contactId)
        results.tests.getContact = {
          name: 'Get Contact',
          success: true,
          data: {
            id: contact.id,
            name: `${contact.firstName} ${contact.lastName}`,
            phone: contact.phone,
            email: contact.email,
            tags: contact.tags
          }
        }
        results.summary.passed++
        console.log('✅ Get Contact successful')
      } catch (error) {
        results.tests.getContact = {
          name: 'Get Contact',
          success: false,
          error: error.message
        }
        results.summary.failed++
        console.log('❌ Get Contact failed:', error.message)
      }
      results.summary.total++

      // ==================== TEST 5: UPDATE CONTACT ====================
      console.log('\n📋 TEST 5: Update Contact')
      try {
        const updated = await ghlService.updateContact(contactId, {
          firstName: 'Updated',
          lastName: `Name_${uniqueId}`,
          tags: ['updated_tag']
        })
        results.tests.updateContact = {
          name: 'Update Contact',
          success: true,
          data: {
            id: updated.id,
            name: `${updated.firstName} ${updated.lastName}`,
            tags: updated.tags
          }
        }
        results.summary.passed++
        console.log('✅ Update Contact successful')
      } catch (error) {
        results.tests.updateContact = {
          name: 'Update Contact',
          success: false,
          error: error.message
        }
        results.summary.failed++
        console.log('❌ Update Contact failed:', error.message)
      }
      results.summary.total++

      // ==================== TEST 6: ADD TAG ====================
      console.log('\n📋 TEST 6: Add Tag')
      try {
        await ghlService.addTagToContact(contactId, 'test_tag_1')
        await ghlService.addTagToContact(contactId, 'test_tag_2')
        results.tests.addTag = {
          name: 'Add Tag',
          success: true,
          data: { tags: ['test_tag_1', 'test_tag_2'] }
        }
        results.summary.passed++
        console.log('✅ Tags added')
      } catch (error) {
        results.tests.addTag = {
          name: 'Add Tag',
          success: false,
          error: error.message
        }
        results.summary.failed++
        console.log('❌ Add Tag failed:', error.message)
      }
      results.summary.total++

      // ==================== TEST 7: ADD NOTE ====================
      console.log('\n📋 TEST 7: Add Note')
      try {
        await ghlService.addNote(contactId, 'This is a test note from comprehensive test')
        results.tests.addNote = {
          name: 'Add Note',
          success: true
        }
        results.summary.passed++
        console.log('✅ Note added')
      } catch (error) {
        results.tests.addNote = {
          name: 'Add Note',
          success: false,
          error: error.message
        }
        results.summary.failed++
        console.log('❌ Add Note failed:', error.message)
      }
      results.summary.total++

      // ==================== TEST 8: GET NOTES ====================
      console.log('\n📋 TEST 8: Get Notes')
      try {
        const notes = await ghlService.getNotes(contactId)
        results.tests.getNotes = {
          name: 'Get Notes',
          success: true,
          data: { count: notes.length, notes: notes.slice(0, 5) }
        }
        results.summary.passed++
        console.log(`✅ Retrieved ${notes.length} notes`)
      } catch (error) {
        results.tests.getNotes = {
          name: 'Get Notes',
          success: false,
          error: error.message
        }
        results.summary.failed++
        console.log('❌ Get Notes failed:', error.message)
      }
      results.summary.total++

      // ==================== TEST 9: UPDATE CUSTOM FIELD ====================
      console.log('\n📋 TEST 9: Update Custom Field')
      try {
        await ghlService.updateCustomField(contactId, 'test_field', `Updated ${uniqueId}`)
        results.tests.updateCustomField = {
          name: 'Update Custom Field',
          success: true
        }
        results.summary.passed++
        console.log('✅ Custom field updated')
      } catch (error) {
        results.tests.updateCustomField = {
          name: 'Update Custom Field',
          success: false,
          error: error.message
        }
        results.summary.failed++
        console.log('❌ Update Custom Field failed:', error.message)
      }
      results.summary.total++

      // ==================== TEST 10: CONVERSATION ====================
      console.log('\n📋 TEST 10: Get or Create Conversation')
      let conversationId = null
      try {
        const { conversation, action } = await ghlService.getOrCreateConversation(
          contactId,
          'SMS'
        )
        conversationId = conversation.id
        results.tests.getOrCreateConversation = {
          name: 'Get or Create Conversation',
          success: true,
          data: {
            action,
            conversationId: conversation.id
          }
        }
        results.summary.passed++
        console.log(`✅ Conversation ${action}: ${conversation.id}`)
      } catch (error) {
        results.tests.getOrCreateConversation = {
          name: 'Get or Create Conversation',
          success: false,
          error: error.message
        }
        results.summary.failed++
        console.log('❌ Get or Create Conversation failed:', error.message)
      }
      results.summary.total++

      if (conversationId) {
        // ==================== TEST 11: ADD MESSAGE ====================
        console.log('\n📋 TEST 11: Add Message to Conversation')
        try {
          const message = await ghlService.addMessageToConversation(conversationId, {
            contactId: contactId,
            body: 'This is a test message from comprehensive test',
            messageType: 'SMS',
            direction: 'outbound',
            fromNumber: process.env.TALLBOB_NUMBER || '+1234567890',
            toNumber: testPhone,
            date: new Date().toISOString(),
            provider: 'Test'
          })
          results.tests.addMessage = {
            name: 'Add Message',
            success: true,
            data: {
              messageId: message.id,
              conversationId: message.conversationId
            }
          }
          results.summary.passed++
          console.log('✅ Message added')
        } catch (error) {
          results.tests.addMessage = {
            name: 'Add Message',
            success: false,
            error: error.message
          }
          results.summary.failed++
          console.log('❌ Add Message failed:', error.message)
        }
        results.summary.total++

        // ==================== TEST 12: GET MESSAGES ====================
        console.log('\n📋 TEST 12: Get Conversation Messages')
        try {
          const messages = await ghlService.getConversationMessages(conversationId)
          results.tests.getMessages = {
            name: 'Get Messages',
            success: true,
            data: { count: messages.length }
          }
          results.summary.passed++
          console.log(`✅ Retrieved ${messages.length} messages`)
        } catch (error) {
          results.tests.getMessages = {
            name: 'Get Messages',
            success: false,
            error: error.message
          }
          results.summary.failed++
          console.log('❌ Get Messages failed:', error.message)
        }
        results.summary.total++
      }

      // ==================== TEST 13: REMOVE TAG ====================
      console.log('\n📋 TEST 13: Remove Tag')
      try {
        await ghlService.removeTagFromContact(contactId, 'test_tag_1')
        results.tests.removeTag = {
          name: 'Remove Tag',
          success: true
        }
        results.summary.passed++
        console.log('✅ Tag removed')
      } catch (error) {
        results.tests.removeTag = {
          name: 'Remove Tag',
          success: false,
          error: error.message
        }
        results.summary.failed++
        console.log('❌ Remove Tag failed:', error.message)
      }
      results.summary.total++
    }

    // ==================== TEST 14: SEARCH CONTACTS ====================
    console.log('\n📋 TEST 14: Search Contacts by Phone')
    try {
      const contacts = await ghlService.searchContactsByPhone(testPhone)
      results.tests.searchContacts = {
        name: 'Search Contacts',
        success: true,
        data: { count: contacts.length }
      }
      results.summary.passed++
      console.log(`✅ Found ${contacts.length} contacts`)
    } catch (error) {
      results.tests.searchContacts = {
        name: 'Search Contacts',
        success: false,
        error: error.message
      }
      results.summary.failed++
      console.log('❌ Search Contacts failed:', error.message)
    }
    results.summary.total++

    // ==================== TEST 15: TEST CONNECTION ====================
    console.log('\n📋 TEST 15: Test Connection')
    try {
      const connection = await ghlService.testConnection()
      results.tests.testConnection = {
        name: 'Test Connection',
        success: true,
        data: connection
      }
      results.summary.passed++
      console.log('✅ Connection test passed')
    } catch (error) {
      results.tests.testConnection = {
        name: 'Test Connection',
        success: false,
        error: error.message
      }
      results.summary.failed++
      console.log('❌ Connection test failed:', error.message)
    }
    results.summary.total++

    // ==================== TEST SUMMARY ====================
    const endTime = Date.now()
    const duration = (endTime - startTime) / 1000

    console.log('\n✅ ========== TEST SUMMARY ==========')
    console.log(`📍 Location ID: ${ghlService.locationId}`)
    console.log(`📊 Tests Run: ${results.summary.total}`)
    console.log(`✅ Passed: ${results.summary.passed}`)
    console.log(`❌ Failed: ${results.summary.failed}`)
    console.log(`⏱️ Duration: ${duration.toFixed(2)} seconds`)

    res.json({
      success: results.summary.failed === 0,
      summary: results.summary,
      duration: `${duration.toFixed(2)}s`,
      results: results.tests
    })

  } catch (error) {
    console.error('❌ Test suite error:', error)
    res.status(500).json({
      success: false,
      error: error.message,
      partialResults: results
    })
  }
})

// Simple test route to get all conversations for a phone number
app.get('/test/ghl/phone-convos', async (req, res) => {
  try {
    const { phone } = req.query
    
    if (!phone) {
      return res.status(400).json({ 
        success: false, 
        error: 'Please provide a phone number using ?phone= parameter' 
      })
    }

    console.log(`\n📱 Getting all conversations for: ${phone}`)
    
    // Format phone
    const cleanPhone = phone.replace(/\D/g, '')
    const formattedPhone = `+${cleanPhone}`
    console.log(`📞 Formatted: ${formattedPhone}`)

    // Find contact
    const contacts = await ghlService.searchContactsByPhone(formattedPhone)
    
    if (!contacts || contacts.length === 0) {
      return res.json({
        success: false,
        message: 'No contact found with this phone number',
        phone: formattedPhone
      })
    }

    const contact = contacts[0]
    console.log(`✅ Contact: ${contact.id} - ${contact.firstName || ''} ${contact.lastName || ''}`)

    // Get all conversations
    const conversations = await ghlService.searchConversations({
      contactId: contact.id,
      limit: 50
    })

    console.log(`✅ Found ${conversations.length} conversations`)
    
    res.json({
      success: true,
      phone: formattedPhone,
      contact: {
        id: contact.id,
        name: `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || 'Unknown',
        phone: contact.phone,
        email: contact.email
      },
      totalConversations: conversations.length,
      conversations: conversations.map(c => ({
        id: c.id,
        type: c.type || 'SMS',
        lastMessageAt: c.lastMessageAt,
        lastMessageBody: c.lastMessageBody ? c.lastMessageBody.substring(0, 100) : null,
        lastMessageDirection: c.lastMessageDirection,
        unreadCount: c.unreadCount || 0
      }))
    })

  } catch (error) {
    console.error('❌ Error:', error)
    res.status(500).json({ 
      success: false, 
      error: error.message 
    })
  }
})

// ==================== MOUNT ROUTES ====================
// Pass all services to routes
routes(app, tallbobService, ghlService, messageController, bluebubblesService)

// Static files
app.use(express.static('dist'))

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err.stack)
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  })
})

// ==================== START POLLING SERVICE ====================
// Initialize and start polling after server starts
;(async () => {
  try {
    await pollingService.initialize()
    console.log('✅ Polling service started')
  } catch (error) {
    console.error('❌ Failed to start polling service:', error)
  }
})()

// ==================== HTTPS SERVER SETUP ====================
const HTTP_PORT = process.env.PORT || 80
const HTTPS_PORT = 443
const certDir = 'C:\\certificates\\'

const certPath = path.join(certDir, 'cayked.store-crt.pem')
const keyPath = path.join(certDir, 'cayked.store-key.pem')
const chainPath = path.join(certDir, 'cayked.store-chain.pem')

function startHttpServer() {
  http.createServer(app).listen(HTTP_PORT, () => {
    console.log(`✅ HTTP Server running on port ${HTTP_PORT}`)
    console.log(`📱 Tall Bob service: ${tallbobService.baseURL}`)
    console.log(`📊 GHL service: configured`)
    if (bluebubblesService) {
      console.log(`💬 BlueBubbles service: ${bluebubblesService.serverUrl}`)
    }
  })
}

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  try {
    console.log('\n🔐 Found SSL certificates, starting HTTPS server...')
    console.log('📁 Using:')
    console.log(`   - Cert: ${path.basename(certPath)}`)
    console.log(`   - Key: ${path.basename(keyPath)}`)
    
    const httpsOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    }
    
    if (fs.existsSync(chainPath)) {
      httpsOptions.ca = fs.readFileSync(chainPath)
      console.log(`   - Chain: ${path.basename(chainPath)}`)
    }

    https.createServer(httpsOptions, app).listen(HTTPS_PORT, () => {
      console.log(`✅ HTTPS Server running on port ${HTTPS_PORT}`)
      console.log(`🔒 Secure access: https://cayked.store`)
      console.log(`🔒 Secure access: https://www.cayked.store`)
    })

    http.createServer((req, res) => {
      const host = req.headers.host?.split(':')[0] || 'cayked.store'
      res.writeHead(301, { Location: `https://${host}${req.url}` })
      res.end()
    }).listen(HTTP_PORT, () => {
      console.log(`↪️ HTTP on port ${HTTP_PORT} redirecting to HTTPS`)
    })

  } catch (err) {
    console.error('❌ Failed to start HTTPS server:', err.message)
    console.log('⚠️ Falling back to HTTP only')
    startHttpServer()
  }
} else {
  console.log(`\n⚠️ Certificate files not found in: ${certDir}`)
  console.log('Starting with HTTP only...')
  startHttpServer()
}