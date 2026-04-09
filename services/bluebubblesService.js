// services/bluebubbles.service.js
import axios from 'axios';
import FormData from 'form-data';

class BlueBubblesService {
  constructor() {
    this.serverUrl = process.env.BLUEBUBBLES_SERVER_URL || 'http://localhost:3030';
    this.password = process.env.BLUEBUBBLES_PASSWORD;
    this.imessageAccount = process.env.BLUEBUBBLES_IMESSAGE_ACCOUNT;
    
    if (!this.password) {
      console.error('❌ BLUEBUBBLES_PASSWORD not set');
    }
    
    // Create axios instance without baseURL to be flexible
    this.client = axios.create({
      timeout: 30000
    });
    
    console.log('📱 BlueBubbles Service Initialized:');
    console.log(`   Server URL: ${this.serverUrl}`);
    console.log(`   Password: ${this.password ? '***' : 'Not set'}`);
  }

  /**
   * Send an iMessage via BlueBubbles
   * Using the correct API endpoint based on BlueBubbles documentation
   */
  async sendMessage({ to, from, message, effectId = null }) {
    try {
      console.log(`\n📱 Sending iMessage via BlueBubbles API:`);
      console.log(`   To: ${to}`);
      console.log(`   Message: ${message}`);
      
      // Format the chat GUID correctly
      let chatGuid;
      if (to.includes('@')) {
        chatGuid = to;
      } else {
        // Clean the phone number
        const cleanNumber = to.replace(/\D/g, '');
        chatGuid = cleanNumber;
      }
      
      console.log(`   Chat GUID: ${chatGuid}`);
      
      // Try different possible endpoints
      const endpoints = [
        '/send-message',
        '/api/v1/message/send',
        '/message/send',
        '/send'
      ];
      
      let lastError = null;
      
      for (const endpoint of endpoints) {
        try {
          console.log(`   Trying endpoint: ${endpoint}`);
          
          const payload = {
            chatGuid: chatGuid,
            message: message,
            method: 'appleScript'
          };
          
          if (effectId) payload.effectId = effectId;
          if (from) payload.from = from;
          
          const response = await this.client.post(`${this.serverUrl}${endpoint}`, payload, {
            headers: {
              'Authorization': `Bearer ${this.password}`,
              'Content-Type': 'application/json'
            }
          });
          
          console.log(`   ✅ Message sent successfully using ${endpoint}!`);
          return {
            success: true,
            guid: response.data.guid || response.data.messageId,
            messageId: response.data.guid || response.data.messageId
          };
          
        } catch (err) {
          lastError = err;
          if (err.response?.status !== 404) {
            // If it's not a 404, this might be a different error, break
            throw err;
          }
          console.log(`   Endpoint ${endpoint} returned 404, trying next...`);
        }
      }
      
      throw lastError || new Error('No working endpoint found');
      
    } catch (error) {
      console.error(`   ❌ BlueBubbles send error:`, error.response?.data || error.message);
      console.error(`   Status: ${error.response?.status}`);
      
      // Provide helpful troubleshooting info
      if (error.code === 'ECONNREFUSED') {
        console.error(`   ⚠️ Cannot connect to BlueBubbles server at ${this.serverUrl}`);
        console.error(`   Make sure BlueBubbles is running on your Mac`);
        console.error(`   Check the server URL in your .env file: BLUEBUBBLES_SERVER_URL`);
      } else if (error.response?.status === 401) {
        console.error(`   ⚠️ Authentication failed - check your BLUEBUBBLES_PASSWORD`);
      } else if (error.response?.status === 404) {
        console.error(`   ⚠️ API endpoint not found - check your BlueBubbles version`);
        console.error(`   Try accessing ${this.serverUrl} in your browser to see if BlueBubbles is running`);
      }
      
      throw new Error(`Failed to send iMessage: ${error.message}`);
    }
  }

  /**
   * Alternative method using BlueBubbles' native AppleScript command
   * This uses the direct AppleScript endpoint if available
   */
  async sendMessageAppleScript({ to, message }) {
    try {
      console.log(`📱 Sending iMessage via AppleScript endpoint`);
      
      // Some BlueBubbles versions use a different endpoint for AppleScript
      const response = await this.client.post(`${this.serverUrl}/apple-script`, {
        command: `tell application "Messages" to send "${message}" to buddy "${to}"`
      }, {
        headers: {
          'Authorization': `Bearer ${this.password}`,
          'Content-Type': 'application/json'
        }
      });
      
      return {
        success: true,
        guid: response.data.guid
      };
      
    } catch (error) {
      console.error(`   ❌ AppleScript send failed:`, error.message);
      throw error;
    }
  }

  /**
   * Send an attachment
   */
  async sendAttachment({ to, from, message, mediaUrl, effectId = null }) {
    try {
      console.log(`📸 Sending attachment via BlueBubbles to ${to}`);
      console.log(`   Media URL: ${mediaUrl}`);
      
      let chatGuid;
      if (to.includes('@')) {
        chatGuid = to;
      } else {
        const cleanNumber = to.replace(/\D/g, '');
        chatGuid = cleanNumber;
      }
      
      // Try to download the image first if it's a URL
      let fileData;
      if (mediaUrl.startsWith('http')) {
        try {
          const imageResponse = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
          fileData = Buffer.from(imageResponse.data, 'binary');
        } catch (err) {
          console.log(`   Could not download image, using URL instead`);
        }
      }
      
      // Try sending with file upload
      const formData = new FormData();
      formData.append('chatGuid', chatGuid);
      formData.append('message', message || '📎 Attachment');
      
      if (fileData) {
        formData.append('file', fileData, { filename: 'attachment.jpg' });
      } else if (mediaUrl) {
        formData.append('fileUrl', mediaUrl);
      }
      
      if (effectId) formData.append('effectId', effectId);
      if (from) formData.append('from', from);
      
      const response = await this.client.post(`${this.serverUrl}/send-message`, formData, {
        headers: {
          'Authorization': `Bearer ${this.password}`,
          ...formData.getHeaders()
        }
      });
      
      return {
        success: true,
        guid: response.data.guid
      };
      
    } catch (error) {
      console.error(`   ❌ Failed to send attachment:`, error.message);
      throw error;
    }
  }

  /**
   * Get server status - useful for debugging
   */
  async getStatus() {
    try {
      // Try to ping the server
      const response = await this.client.get(`${this.serverUrl}/ping`, {
        headers: { 'Authorization': `Bearer ${this.password}` }
      });
      return { status: 'connected', data: response.data };
    } catch (error) {
      console.error('Failed to get BlueBubbles status:', error.message);
      return { status: 'error', message: error.message, url: this.serverUrl };
    }
  }

  /**
   * Get available chats (useful for debugging)
   */
  async getChats(limit = 20) {
    try {
      const response = await this.client.get(`${this.serverUrl}/chats?limit=${limit}`, {
        headers: { 'Authorization': `Bearer ${this.password}` }
      });
      return response.data;
    } catch (error) {
      console.error('Failed to get chats:', error.message);
      return [];
    }
  }

  /**
   * Send typing indicator
   */
  async sendTypingIndicator(chatGuid, isTyping = true) {
    try {
      const response = await this.client.post(`${this.serverUrl}/typing`, {
        chatGuid: chatGuid,
        isTyping: isTyping
      }, {
        headers: { 'Authorization': `Bearer ${this.password}` }
      });
      return response.data;
    } catch (error) {
      console.error('Failed to send typing indicator:', error.message);
      return null;
    }
  }
}

export default BlueBubblesService;