import axios from 'axios';

class TallBobService {
  constructor() {
    // --- Configuration ---
    // Your API username and key from Tall Bob settings
    // IMPORTANT: Store these in your .env file, not in code!
    this.apiUsername = process.env.TALLBOB_API_USERNAME;
    this.apiKey = process.env.TALLBOB_API_KEY;

    if (!this.apiUsername || !this.apiKey) {
      console.error('❌ Missing Tall Bob API credentials in environment variables.');
      // In a real app, you might throw an error or handle this more gracefully.
    }
    const pass = `ZTRlNzU1MGMtMTA2YS0xMWYxLWIwMDAtMjM0YTI1YTI1MTFiOmYyNjc5ODZhNGFjZjk2MWE0ODQyYmRmOTcwYjY5ZThkYTBjZWM0MzZhNWVkMTE1N2Q4NTViNDExZWI4N2JjZGU=`
    // Construct the Basic Auth header
    const authString = `${this.apiUsername}:${this.apiKey}`;
    const base64Auth = Buffer.from(authString).toString('base64');
    this.authHeader = `Basic ${pass}`;

    // Set the base URL based on environment (from .env)
    this.baseURL = process.env.NODE_ENV === 'production'
      ? 'https://api.tallbob.com'  // Production base
      : 'https://api.tallbob.com'; // Sandbox base

    // --- Axios Client Setup ---
    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Authorization': this.authHeader,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      maxBodyLength: Infinity // As per docs for larger requests
    });

    // --- Request/Response Interceptors for Debugging ---
    this.client.interceptors.request.use(request => {
      console.log('📤 Tall Bob Request:', {
        method: request.method,
        baseURL: request.baseURL,
        url: request.url,
        // Log data safely, maybe hide parts if needed
        data: request.data
      });
      return request;
    });

    this.client.interceptors.response.use(
      response => {
        console.log('📥 Tall Bob Response:', {
          status: response.status,
          statusText: response.statusText,
          data: response.data
        });
        return response;
      },
      error => {
        console.error('❌ Tall Bob API Error:', {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
          message: error.message
        });
        // Return a rejected promise so the calling function can handle it
        return Promise.reject(error);
      }
    );
  }

  /**
   * Format phone number to Tall Bob's expected format (E.164 without leading +).
   * Examples: "61499000100", "12025550123"
   * @param {string} phoneNumber - The phone number in various formats.
   * @returns {string} Formatted phone number.
   */
  formatPhoneNumber(phoneNumber) {
    // Remove all non-numeric characters
    let cleaned = phoneNumber.replace(/\D/g, '');

    // If it starts with '00', replace with the appropriate country code? 
    // For simplicity, we assume it's either already in international format without '+'
    // or it's a local number. This logic might need refinement based on your use case.
    
    // If the number starts with '0' (typical local format), assume Australia (61) and remove the leading 0.
    if (cleaned.startsWith('0')) {
        // Remove leading 0 and add 61 (Australia). 
        // WARNING: This assumes all local numbers are Australian. Adjust for your region.
        cleaned = '61' + cleaned.substring(1);
    }
    
    // If the number doesn't start with a country code (e.g., 61, 1), you might need to add a default.
    // This is a complex area; the safest is to ensure the calling code provides the number in the correct format.
    
    // Remove any '+' that might have been left.
    cleaned = cleaned.replace('+', '');
    
    return cleaned;
  }

  /**
   * Send an SMS via Tall Bob.
   * POST /v2/sms/send
   * @param {Object} params
   * @param {string} params.to - Recipient phone number (E.164 without +, e.g., 61499000100).
   * @param {string} params.message - The message content. Max 1570 chars. Include {OptOutURL} for marketing.
   * @param {string} params.from - Sender ID (phone number or alphanumeric string, 11 chars max).
   * @param {string} [params.reference] - Your unique reference for the message.
   * @returns {Promise<Object>} Tall Bob API response.
   */
  async sendSMS({ to, message, from, reference }) {
    try {
      const payload = {
        to: '61477273504',
        message: message,
        from: '+61428616133',
        reference: reference
      };

      console.log(`📱 Sending SMS to ${payload.to}`);
      const response = await this.client.post('/v2/sms/send', payload);
      return response.data;
    } catch (error) {
      console.error('Failed to send SMS via Tall Bob:', error.response?.data || error.message);
      throw new Error(`Tall Bob SMS send failed: ${error.message}`);
    }
  }

  /**
   * Send an MMS via Tall Bob.
   * POST /v2/chat/send/mms
   * @param {Object} params
   * @param {string} params.to - Recipient phone number (E.164 without +).
   * @param {string} params.message - The message content.
   * @param {string} params.from - Sender ID.
   * @param {string} params.mediaUrl - URL of the media file (image, video, etc.). Max 1500KB.
   * @param {string} [params.reference] - Your unique reference.
   * @returns {Promise<Object>} Tall Bob API response.
   */
  async sendMMS({ to, message, from, mediaUrl, reference }) {
    try {
      const payload = {
        to: '61477273504',
        message: 'A picture is worth a thousand words...',
        from: '+61428616133',
        url: `https://picsum.photos/200/300.jpg`,
        subject: "A walk in the park",
        reference: reference
      };

      console.log(`📸 Sending MMS to ${payload.to} with media`);
      const response = await this.client.post('/v2/mms/send', payload);
      return response.data;
    } catch (error) {
      console.error('Failed to send MMS via Tall Bob:', error.response?.data || error.message);
      throw new Error(`Tall Bob MMS send failed: ${error.message}`);
    }
  }

  /**
   * Get the status of a message.
   * GET /v2/messages/{messageId}
   * @param {string} messageId - The Tall Bob message ID.
   * @returns {Promise<Object>} Message status.
   */
  async getMessageStatus(messageId) {
    try {
      console.log(`🔍 Getting status for message ID: ${messageId}`);
      // IMPORTANT: Verify this exact endpoint with the docs or Tall Bob support.
      // It might be /v2/messages/{messageId} or /v2/chat/status/{messageId}.
      const response = await this.client.get(`/v2/messages/${messageId}`);
      return response.data;
    } catch (error) {
      console.error('Failed to get message status from Tall Bob:', error.response?.data || error.message);
      throw new Error(`Tall Bob status check failed: ${error.message}`);
    }
  }

  /**
   * Create a webhook to receive incoming messages and delivery receipts.
   * POST /v2/webhooks
   * @param {Object} config
   * @param {string} config.url - The URL where Tall Bob will send POST requests.
   * @param {Array<string>} config.events - Events to listen for (e.g., ['message.received', 'message.delivered']).
   * @returns {Promise<Object>} Webhook creation response.
   */
  async createWebhook() {
    try {
      const payload = {
        url: "https://cayked.store/tallbob/incoming",
        event_type: "message.received"
      }
      console.log(`🔗 Creating webhook for URL: ${url}`);
      const response = await this.client.post('/v2/webhooks', payload);
      return response.data;
    } catch (error) {
      console.error('Failed to create Tall Bob webhook:', error.response?.data || error.message);
      throw new Error(`Tall Bob webhook creation failed: ${error.message}`);
    }
  }

  /**
   * Test the connection by sending a simple SMS to a known test number.
   * @returns {Promise<Object>} Result of the connection test.
   */
  async testConnection() {
    try {
      console.log('🧪 Testing Tall Bob connection...');
      const result = await this.sendSMS({
        to: '61499000100', // Use the example number from docs for testing
        from: 'TestSender', // Ensure this is a valid sender ID for your test account
        message: 'Tall Bob integration connection test.',
        reference: `conn_test_${Date.now()}`
      });
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

export default TallBobService;