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
import BlueBubblesService from './services/bluebubblesService.js'
import routes from './routes/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
global.__basedir = __dirname

// Validate environment variables
const requiredEnvVars = [
  'GHL_PRIVATE_INTEGRATION_TOKEN',
  'TALLBOB_GHL_LOCATION_ID',  // Changed from GHL_LOCATION_ID
  'BLUEBUBBLES_GHL_LOCATION_ID',  // Added BlueBubbles location ID
  'TALLBOB_API_USERNAME',
  'TALLBOB_API_KEY'
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

// Initialize services
const tallbobService = new TallBobService()
const ghlService = new GHLService()

// Initialize BlueBubbles (optional)
let bluebubblesService = null
if (process.env.BLUEBUBBLES_SERVER_URL && process.env.BLUEBUBBLES_PASSWORD) {
  bluebubblesService = new BlueBubblesService()
  console.log('📱 BlueBubbles service initialized')
} else {
  console.log('⚠️ BlueBubbles service not initialized (missing config)')
}

// Initialize tracker (still needed for deduplication)
const commentTracker = new CommentTracker()
await commentTracker.initialize()
console.log('✅ Comment tracker initialized')

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
} catch (error) {
  console.error('⚠️ Failed to create Tall Bob webhooks:', error.message)
}

// ==================== HEALTH CHECK ENDPOINTS ====================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    services: {
      tallbob: !!tallbobService,
      ghl: !!ghlService,
      bluebubbles: !!bluebubblesService,
      tracker: !!commentTracker
    },
    subAccounts: {
      tallbob: process.env.TALLBOB_GHL_LOCATION_ID,
      bluebubbles: process.env.BLUEBUBBLES_GHL_LOCATION_ID
    }
  })
})

app.get('/tracker/stats', async (req, res) => {
  const count = await commentTracker.getCount()
  const stats = await commentTracker.getStats()
  res.json({
    success: true,
    trackedContacts: count,
    stats: stats
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
      const { to, message, effectId } = req.body
      
      if (!to || !message) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: to, message'
        })
      }
      
      const result = await bluebubblesService.sendMessage({
        to,
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
    
    const cleanPhone = phone.replace(/\D/g, '')
    const formattedPhone = `+${cleanPhone}`
    console.log(`📞 Formatted: ${formattedPhone}`)

    // Note: This will search in the default location (Tall Bob)
    // You can specify which sub-account to search by passing locationId
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
// Mount all webhook routes
routes(app, tallbobService, ghlService, bluebubblesService)

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

// ==================== HTTPS SERVER SETUP ====================
const HTTP_PORT = process.env.PORT || 80
const HTTPS_PORT = 443
const certDir = 'C:\\certificates\\'

const certPath = path.join(certDir, 'cayked.store-crt.pem')
const keyPath = path.join(certDir, 'cayked.store-key.pem')
const chainPath = path.join(certDir, 'cayked.store-chain.pem')

function startHttpServer() {
  http.createServer(app).listen(HTTP_PORT, () => {
    console.log(`\n${'='.repeat(60)}`)
    console.log(`🚀 SERVER STARTED (WEBHOOK MODE - NO POLLING)`)
    console.log(`${'='.repeat(60)}`)
    console.log(`✅ HTTP Server running on port ${HTTP_PORT}`)
    console.log(`📱 Tall Bob service: ${tallbobService.baseURL}`)
    console.log(`📊 GHL service: configured`)
    console.log(`📍 Tall Bob sub-account: ${process.env.TALLBOB_GHL_LOCATION_ID}`)
    console.log(`📍 BlueBubbles sub-account: ${process.env.BLUEBUBBLES_GHL_LOCATION_ID}`)
    if (bluebubblesService) {
      console.log(`💬 BlueBubbles service: ${bluebubblesService.serverUrl}`)
    }
    console.log(`\n📡 Webhook endpoints:`)
    console.log(`   • Tall Bob SMS: https://cayked.store/tallbob/incoming/sms`)
    console.log(`   • Tall Bob MMS: https://cayked.store/tallbob/incoming/mms`)
    console.log(`   • BlueBubbles: https://cayked.store/bluebubbles/incoming`)
    console.log(`   • GHL Internal Comment: https://cayked.store/webhook/ghl/internal-comment`)
    console.log(`\n💡 System is running in WEBHOOK mode - no polling, instant responses!\n`)
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
      console.log(`\n${'='.repeat(60)}`)
      console.log(`🚀 SERVER STARTED (WEBHOOK MODE - NO POLLING)`)
      console.log(`${'='.repeat(60)}`)
      console.log(`✅ HTTPS Server running on port ${HTTPS_PORT}`)
      console.log(`🔒 Secure access: https://cayked.store`)
      console.log(`🔒 Secure access: https://www.cayked.store`)
      console.log(`📱 Tall Bob service: ${tallbobService.baseURL}`)
      console.log(`📊 GHL service: configured`)
      console.log(`📍 Tall Bob sub-account: ${process.env.TALLBOB_GHL_LOCATION_ID}`)
      console.log(`📍 BlueBubbles sub-account: ${process.env.BLUEBUBBLES_GHL_LOCATION_ID}`)
      if (bluebubblesService) {
        console.log(`💬 BlueBubbles service: ${bluebubblesService.serverUrl}`)
      }
      console.log(`\n📡 Webhook endpoints:`)
      console.log(`   • Tall Bob SMS: https://cayked.store/tallbob/incoming/sms`)
      console.log(`   • Tall Bob MMS: https://cayked.store/tallbob/incoming/mms`)
      console.log(`   • BlueBubbles: https://cayked.store/bluebubbles/incoming`)
      console.log(`   • GHL Internal Comment: https://cayked.store/webhook/ghl/internal-comment`)
      console.log(`\n💡 System is running in WEBHOOK mode - no polling, instant responses!\n`)
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