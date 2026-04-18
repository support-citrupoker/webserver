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
const ghlService = new GHLService()

// Initialize BlueBubbles (optional)
let bluebubblesService = null
if (process.env.BLUEBUBBLES_SERVER_URL && process.env.BLUEBUBBLES_PASSWORD) {
  bluebubblesService = new BlueBubblesService()
  console.log('📱 BlueBubbles service initialized')
} else {
  console.log('⚠️ BlueBubbles service not initialized (missing config)')
}

// Initialize tracker
const commentTracker = new CommentTracker()

// ==================== POLLING SERVICE CONFIGURATION ====================
const pollingService = new PollingService(
  ghlService, 
  tallbobService, 
  commentTracker, 
  bluebubblesService,
  {
    batchSize: 20,
    delayBetweenContacts: 12000,
    delayBetweenPolls: 240000,
    pollInterval: '*/12 * * * *',
    debug: true,  
    syncBatchSize: 5,
    syncInterval: '0 */6 * * *',
    delayBetweenPages: 120000,
    delayAfterRateLimit: 1800000,
    delayAfterError: 1800000,
  }
)

// Log polling configuration
console.log('\n📊 POLLING SERVICE CONFIGURATION:')
console.log(`   • Batch size: ${pollingService.batchSize} contacts/poll`)
console.log(`   • Delay between contacts: ${pollingService.delayBetweenContacts/1000} seconds`)
console.log(`   • Delay between polls: ${pollingService.delayBetweenPolls/60000} minutes`)
console.log(`   • Poll interval: ${pollingService.pollInterval}`)
console.log(`   • Expected polls per hour: ${Math.floor(60 / (parseInt(pollingService.pollInterval.split('/')[1]) || 12))}`)
console.log(`   • Expected throughput: ~${pollingService.batchSize * Math.floor(60 / (parseInt(pollingService.pollInterval.split('/')[1]) || 12))} contacts/hour`)
console.log(`   • Daily capacity: ~${pollingService.batchSize * Math.floor(60 / (parseInt(pollingService.pollInterval.split('/')[1]) || 12)) * 24} contacts/day`)
console.log(`   • Sync interval: ${pollingService.syncInterval}`)
console.log(`   • Sync batch size: ${pollingService.syncBatchSize} contacts/page\n`)

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
  // ... (keep your existing comprehensive test)
  res.json({ success: true, message: 'GHL test endpoint' })
})

// Simple test route to get all conversations for a phone number
app.get('/test/ghl/phone-convos', async (req, res) => {
  // ... (keep your existing phone convos test)
  res.json({ success: true, message: 'Phone convos endpoint' })
})

// ==================== MOUNT ROUTES ====================
// FIXED: Pass correct number of arguments (app, tallbobService, ghlService, bluebubblesService)
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

// ==================== START POLLING SERVICE ====================
;(async () => {
  try {
    if (pollingService && typeof pollingService.initialize === 'function') {
      await pollingService.initialize()
      console.log('✅ Polling service initialized and started')
    } else {
      console.log('⚠️ Polling service has no initialize method, but will run on schedule')
      if (pollingService && typeof pollingService.startPolling === 'function') {
        pollingService.startPolling()
        console.log('✅ Polling scheduler started manually')
      }
      if (pollingService && typeof pollingService.startContactSync === 'function') {
        pollingService.startContactSync()
        console.log('✅ Contact sync scheduler started manually')
      }
    }
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