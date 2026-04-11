// services/bluebubbles.service.js
import axios from 'axios';
import { randomUUID } from 'crypto';

class BlueBubblesService {
  constructor() {
    this.serverUrl = process.env.BLUEBUBBLES_SERVER_URL || 'http://localhost:3030';
    this.password = process.env.BLUEBUBBLES_PASSWORD;
    this.imessageAccount = process.env.BLUEBUBBLES_IMESSAGE_ACCOUNT;
    
    if (!this.password) {
      console.error('❌ BLUEBUBBLES_PASSWORD not set');
    }
    
    this.client = axios.create({
      timeout: 30000
    });
    
    console.log('📱 BlueBubbles Service Initialized:');
    console.log(`   Server URL: ${this.serverUrl}`);
    console.log(`   Password: ${this.password ? '***' : 'Not set'}`);
  }

  /**
   * Generate a proper tempGuid in the format that BlueBubbles expects
   * Format: temp-{UUID}
   * Example: temp-3F7A8B9C-0D1E-4F2A-8B3C-4D5E6F7A8B9C
   * This matches the working curl command: "tempGuid": "temp-'"$(uuidgen)"'"
   */
  generateTempGuid() {
    const uuid = randomUUID();
    return `temp-${uuid}`;
  }

  /**
   * Format phone number to the required format
   * Ensures number starts with + and has no spaces or special chars
   */
  formatPhoneNumber(phone) {
    if (!phone) return phone;
    
    // Remove all non-digit characters
    let cleaned = phone.replace(/\D/g, '');
    
    // Remove leading zero if present (for Australian numbers)
    if (cleaned.startsWith('0')) {
      cleaned = cleaned.substring(1);
    }
    
    // Add + prefix
    return `+${cleaned}`;
  }

  /**
   * Send an iMessage via BlueBubbles
   * Uses the WORKING endpoint: /api/v1/message/text
   * 
   * Working curl command reference:
   * curl -s https://tablet-gras-bless-pick.trycloudflare.com/api/v1/message/text?password=Evans123_1! \
   *   -X POST \
   *   -H 'Content-Type: application/json' \
   *   --data-raw '{
   *     "chatGuid": "+61477273504",
   *     "tempGuid": "temp-'"$(uuidgen)"'",
   *     "message": "Finally it works"
   *   }'
   */
  async sendMessage({ to, message, from = null, effectId = null }) {
    try {
      console.log(`\n📱 Sending iMessage via BlueBubbles API:`);
      console.log(`   To: ${to}`);
      console.log(`   Message: ${message}`);
      
      // Format the chat GUID - use exactly as working curl command
      let chatGuid;
      if (to.includes('@')) {
        chatGuid = to;
      } else {
        chatGuid = this.formatPhoneNumber(to);
      }
      
      // Generate a proper UUID-based tempGuid (CRITICAL for BlueBubbles)
      const tempGuid = this.generateTempGuid();
      
      console.log(`   Chat GUID: ${chatGuid}`);
      console.log(`   Temp GUID: ${tempGuid} (UUID format - required)`);
      
      // Use the WORKING endpoint exactly as in curl command
      const endpoint = `/api/v1/message/text`;
      const url = `${this.serverUrl}${endpoint}?password=${this.password}`;
      
      const payload = {
        chatGuid: chatGuid,
        tempGuid: tempGuid,
        message: message
      };
      
      // Add optional fields if provided
      if (effectId) {
        payload.effectId = effectId;
      }
      
      console.log(`   Endpoint: ${endpoint}`);
      console.log(`   Payload:`, JSON.stringify(payload, null, 2));
      
      const response = await this.client.post(url, payload, {
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      // Check response status
      if (response.data && response.data.status === 200) {
        console.log(`   ✅ Message sent successfully!`);
        console.log(`   Message GUID: ${response.data.data?.guid}`);
        
        return {
          success: true,
          guid: response.data.data?.guid,
          messageId: response.data.data?.guid,
          tempGuid: tempGuid,
          response: response.data
        };
      } else {
        throw new Error(response.data?.message || 'Unknown error');
      }
      
    } catch (error) {
      console.error(`   ❌ BlueBubbles send error:`);
      
      if (error.response) {
        console.error(`   Status: ${error.response.status}`);
        console.error(`   Data:`, error.response.data);
        
        if (error.response.status === 401) {
          console.error(`   ⚠️ Authentication failed - check your BLUEBUBBLES_PASSWORD`);
        } else if (error.response.status === 500) {
          console.error(`   ⚠️ Server error - check if Messages app is open and signed in on your Mac`);
          console.error(`   Also verify the phone number has iMessage enabled`);
        } else if (error.response.status === 404) {
          console.error(`   ⚠️ Endpoint not found - check your BlueBubbles server URL`);
        }
      } else if (error.code === 'ECONNREFUSED') {
        console.error(`   ⚠️ Cannot connect to BlueBubbles server at ${this.serverUrl}`);
        console.error(`   Make sure BlueBubbles is running on your Mac`);
      } else {
        console.error(`   Error:`, error.message);
      }
      
      throw new Error(`Failed to send iMessage: ${error.message}`);
    }
  }

  /**
   * Send multiple messages in sequence
   * Each message gets its own unique UUID-based tempGuid
   */
  async sendMultipleMessages(messages) {
    const results = [];
    for (const msg of messages) {
      try {
        const result = await this.sendMessage(msg);
        results.push({ success: true, ...result });
      } catch (error) {
        results.push({ success: false, error: error.message, to: msg.to });
      }
      // Small delay between messages to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return results;
  }

  /**
   * Send an attachment via BlueBubbles
   */
  async sendAttachment({ to, message, mediaUrl, from = null, effectId = null }) {
    try {
      console.log(`📸 Sending attachment via BlueBubbles to ${to}`);
      console.log(`   Media URL: ${mediaUrl}`);
      
      // Format chat GUID
      let chatGuid;
      if (to.includes('@')) {
        chatGuid = to;
      } else {
        chatGuid = this.formatPhoneNumber(to);
      }
      
      // Generate proper UUID-based tempGuid
      const tempGuid = this.generateTempGuid();
      
      // Use attachment endpoint
      const endpoint = `/api/v1/message/attachment`;
      const url = `${this.serverUrl}${endpoint}?password=${this.password}`;
      
      // For attachments, use form-data
      const FormData = (await import('form-data')).default;
      const formData = new FormData();
      formData.append('chatGuid', chatGuid);
      formData.append('tempGuid', tempGuid);
      formData.append('message', message || '📎 Attachment');
      
      // If mediaUrl is provided, download and attach the file
      if (mediaUrl) {
        try {
          const imageResponse = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
          const fileBuffer = Buffer.from(imageResponse.data);
          const filename = mediaUrl.split('/').pop() || 'attachment.jpg';
          formData.append('attachment', fileBuffer, { filename });
        } catch (downloadError) {
          console.log(`   Could not download image, sending as URL`);
          formData.append('attachmentUrl', mediaUrl);
        }
      }
      
      if (effectId) formData.append('effectId', effectId);
      if (from) formData.append('from', from);
      
      const response = await this.client.post(url, formData, {
        headers: {
          ...formData.getHeaders()
        }
      });
      
      if (response.data && response.data.status === 200) {
        console.log(`   ✅ Attachment sent successfully!`);
        return {
          success: true,
          guid: response.data.data?.guid,
          messageId: response.data.data?.guid,
          tempGuid: tempGuid
        };
      } else {
        throw new Error(response.data?.message || 'Unknown error');
      }
      
    } catch (error) {
      console.error(`   ❌ Failed to send attachment:`, error.message);
      throw error;
    }
  }

  /**
   * Get server status
   */
  async getStatus() {
    try {
      const response = await this.client.get(`${this.serverUrl}/api/v1/ping?password=${this.password}`);
      return { success: true, status: response.data };
    } catch (error) {
      console.error('Failed to get status:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Query chats (get conversation list)
   */
  async getChats(limit = 20) {
    try {
      const response = await this.client.post(
        `${this.serverUrl}/api/v1/chat/query?password=${this.password}`,
        { limit: limit }
      );
      return response.data.data || [];
    } catch (error) {
      console.error('Failed to get chats:', error.message);
      return [];
    }
  }

  /**
   * Get messages from a specific chat
   */
  async getMessages(chatGuid, limit = 50) {
    try {
      const response = await this.client.get(
        `${this.serverUrl}/api/v1/chat/${chatGuid}/message?password=${this.password}&limit=${limit}`
      );
      return response.data.data || [];
    } catch (error) {
      console.error('Failed to get messages:', error.message);
      return [];
    }
  }
}

export default BlueBubblesService;