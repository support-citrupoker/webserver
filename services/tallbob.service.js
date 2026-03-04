// services/tallbob.service.js
import axios from 'axios';

class TallBobService {
  constructor() {
    // --- Configuration from environment variables ---
    this.apiUsername = process.env.TALLBOB_API_USERNAME;
    this.apiKey = process.env.TALLBOB_API_KEY;
    this.tallbobPhoneNumber = process.env.TALLBOB_PHONE_NUMBER; // Your Tall Bob number
    this.tallbobSenderName = process.env.TALLBOB_SENDER_NAME || 'TallBob'; // Alphanumeric sender ID
    this.webhookBaseUrl = process.env.WEBHOOK_BASE_URL || 'https://cayked.store'; // Your webhook base URL

    if (!this.apiUsername || !this.apiKey) {
      console.error('❌ Missing Tall Bob API credentials in environment variables.');
    }

    if (!this.tallbobPhoneNumber) {
      console.warn('⚠️ TALLBOB_PHONE_NUMBER not set. Using default for testing.');
    }

    // Construct the Basic Auth header from credentials (not hardcoded)
    const authString = `${this.apiUsername}:${this.apiKey}`;
    const base64Auth = Buffer.from(authString).toString('base64');
    this.authHeader = `Basic ${base64Auth}`;

    // Set the base URL (same for both environments as per docs)
    this.baseURL = 'https://api.tallbob.com';

    // --- Axios Client Setup ---
    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Authorization': this.authHeader,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      maxBodyLength: Infinity
    });

    // --- Request/Response Interceptors for Debugging ---
    this.client.interceptors.request.use(request => {
      console.log('📤 Tall Bob Request:', {
        method: request.method,
        url: `${request.baseURL}${request.url}`,
        data: request.data
      });
      return request;
    });

    this.client.interceptors.response.use(
      response => {
        console.log('📥 Tall Bob Response:', {
          status: response.status,
          data: response.data
        });
        return response;
      },
      error => {
        console.error('❌ Tall Bob API Error:', {
          status: error.response?.status,
          data: error.response?.data,
          message: error.message
        });
        return Promise.reject(error);
      }
    );
  }

  /**
   * Format phone number to Tall Bob's expected format (E.164 without leading +).
   * Examples: "61499000100" (Australia), "237652251848" (Cameroon)
   */
  formatPhoneNumber(phoneNumber) {
    if (!phoneNumber) return phoneNumber;
    
    // Remove all non-numeric characters
    let cleaned = phoneNumber.replace(/\D/g, '');

    // If it starts with '0', remove it (local format)
    if (cleaned.startsWith('0')) {
      cleaned = cleaned.substring(1);
    }
    
    // Remove any '+' that might have been left
    cleaned = cleaned.replace('+', '');
    
    return cleaned;
  }

  /**
   * Send an SMS via Tall Bob.
   * POST /v2/sms/send
   */
  async sendSMS({ to, message, from, reference }) {
    try {
      // Use provided values or fall back to defaults
      const payload = {
        to: this.formatPhoneNumber(to),
        message: message,
        from: from || this.tallbobPhoneNumber || this.tallbobSenderName,
        reference: reference || `sms_${Date.now()}`
      };

      console.log(`📱 Sending SMS to ${payload.to}`);
      const response = await this.client.post('/v2/sms/send', payload);
      return response.data;
    } catch (error) {
      console.error('Failed to send SMS:', error.response?.data || error.message);
      throw new Error(`Tall Bob SMS send failed: ${error.message}`);
    }
  }

  /**
   * Send an MMS via Tall Bob.
   * POST /v2/mms/send
   */
  async sendMMS({ to, message, from, mediaUrl, subject, reference }) {
    try {
      const payload = {
        to: this.formatPhoneNumber(to),
        message: message || 'Image message',
        from: from || this.tallbobPhoneNumber || this.tallbobSenderName,
        url: mediaUrl || 'https://picsum.photos/200/300.jpg', // Default test image
        ...(subject && { subject }),
        reference: reference || `mms_${Date.now()}`,
        subject: subject || "Multimedia"
      };

      console.log(`📸 Sending MMS to ${payload.to}`);
      const response = await this.client.post('/v2/mms/send', payload);
      return response.data;
    } catch (error) {
      console.error('Failed to send MMS:', error.response?.data || error.message);
      throw new Error(`Tall Bob MMS send failed: ${error.message}`);
    }
  }

  /**
   * Get message status
   * GET /v2/messages/{messageId}
   */
  async getMessageStatus(messageId) {
    try {
      console.log(`🔍 Getting status for message ID: ${messageId}`);
      const response = await this.client.get(`/v2/messages/${messageId}`);
      return response.data;
    } catch (error) {
      console.error('Failed to get message status:', error.response?.data || error.message);
      throw new Error(`Tall Bob status check failed: ${error.message}`);
    }
  }

  /**
   * Create webhooks for incoming messages
   * POST /v2/webhooks
   */
  async createWebhooks() {
    try {
      console.log('🔗 Creating Tall Bob webhooks...');
      
      // First, list existing webhooks to avoid duplicates
      const existingWebhooks = await this.listWebhooks();
      
      const webhooksToCreate = [
        {
          url: `${this.webhookBaseUrl}/tallbob/incoming/sms`,
          event_type: "message_received"
        },
        {
          url: `${this.webhookBaseUrl}/tallbob/incoming/mms`,
          event_type: "message_received_mms"
        }
      ];

      const results = [];

      for (const webhookConfig of webhooksToCreate) {
        // Check if webhook already exists
        const exists = existingWebhooks.some(
          webhook => webhook.url === webhookConfig.url && 
                     webhook.event_type === webhookConfig.event_type
        );

        if (!exists) {
          console.log(`Creating webhook for ${webhookConfig.event_type} at ${webhookConfig.url}`);
          const response = await this.client.post('/v2/webhooks', webhookConfig);
          results.push(response.data);
        } else {
          console.log(`Webhook for ${webhookConfig.event_type} already exists`);
          results.push({ existing: true, ...webhookConfig });
        }
      }

      return results;
    } catch (error) {
      console.error('Failed to create Tall Bob webhooks:', error.response?.data || error.message);
      throw new Error(`Tall Bob webhook creation failed: ${error.message}`);
    }
  }

  /**
   * List existing webhooks
   * GET /v2/webhooks
   */
  async listWebhooks() {
    try {
      const response = await this.client.get('/v2/webhooks');
      return response.data.webhooks || [];
    } catch (error) {
      console.error('Failed to list webhooks:', error.message);
      return [];
    }
  }

  /**
   * Delete a webhook
   * DELETE /v2/webhooks/{webhookId}
   */
  async deleteWebhook(webhookId) {
    try {
      const response = await this.client.delete(`/v2/webhooks/${webhookId}`);
      return response.data;
    } catch (error) {
      console.error('Failed to delete webhook:', error.message);
      throw error;
    }
  }

  /**
   * Test the connection
   */
  async testConnection() {
    try {
      console.log('🧪 Testing Tall Bob connection...');
      
      // Try to list webhooks as a connection test
      const webhooks = await this.listWebhooks();
      
      return { 
        success: true, 
        message: 'Tall Bob connection successful',
        webhookCount: webhooks.length
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Send a test SMS to a specific number
   */
  async sendTestSMS(to, message = 'Test message from integration') {
    return this.sendSMS({
      to,
      message,
      reference: `test_${Date.now()}`
    });
  }
}

export default TallBobService;