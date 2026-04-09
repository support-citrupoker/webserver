// services/bluebubbles.service.js
import axios from 'axios';

class BlueBubblesService {
  constructor() {
    this.serverUrl = process.env.BLUEBUBBLES_SERVER_URL || 'http://localhost:3030';
    this.password = process.env.BLUEBUBBLES_PASSWORD;
    this.imessageAccount = process.env.BLUEBUBBLES_IMESSAGE_ACCOUNT;
    
    if (!this.password) {
      console.error('❌ BLUEBUBBLES_PASSWORD not set');
    }
    
    this.client = axios.create({
      baseURL: `${this.serverUrl}/api/v1`,
      headers: {
        'Authorization': `Bearer ${this.password}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
    
    console.log('📱 BlueBubbles Service Initialized');
    console.log(`   Server URL: ${this.serverUrl}`);
  }

  /**
   * Send an iMessage via BlueBubbles
   * @param {Object} options - Message options
   * @param {string} options.to - Phone number or email address
   * @param {string} options.message - Message text
   * @param {string} options.from - iMessage account (optional)
   * @param {string} options.effectId - Message effect (optional)
   * @returns {Promise<Object>} - Response from BlueBubbles
   */
  async sendMessage({ to, message, from, effectId = null }) {
    try {
      console.log(`📱 Sending iMessage via BlueBubbles API:`);
      console.log(`   To: ${to}`);
      console.log(`   Message: ${message}`);
      
      // Format the chat GUID based on whether it's a phone number or email
      let chatGuid;
      if (to.includes('@')) {
        // Email address - use as-is
        chatGuid = to;
        console.log(`   Format: Email address`);
      } else {
        // Phone number - need to clean and format
        const cleanNumber = to.replace(/\D/g, '');
        // Remove leading zero if present (Australian numbers)
        const formattedNumber = cleanNumber.startsWith('0') ? cleanNumber.substring(1) : cleanNumber;
        chatGuid = `+${formattedNumber}`;
        console.log(`   Format: Phone number -> ${chatGuid}`);
      }
      
      // Try different methods to send the message
      const methods = ['appleScript', 'api', 'messages'];
      
      for (const method of methods) {
        try {
          console.log(`   Trying method: ${method}`);
          
          const payload = {
            chatGuid: chatGuid,
            message: message,
            method: method,
            effectId: effectId
          };
          
          // Add from account if specified
          if (from) {
            payload.from = from;
          }
          
          const response = await this.client.post('/message/send', payload);
          
          console.log(`   ✅ Message sent successfully using ${method}!`);
          console.log(`   Response:`, response.data);
          
          return {
            success: true,
            guid: response.data.guid,
            messageId: response.data.guid,
            method: method,
            response: response.data
          };
          
        } catch (methodError) {
          console.log(`   ❌ Method ${method} failed:`, methodError.response?.data?.message || methodError.message);
          // Continue to next method
        }
      }
      
      // If all methods fail, throw error
      throw new Error('All sending methods failed');
      
    } catch (error) {
      console.error(`   ❌ Failed to send iMessage:`, error.response?.data || error.message);
      throw new Error(`BlueBubbles send failed: ${error.message}`);
    }
  }

  /**
   * Send an attachment (image, video, etc.) via BlueBubbles
   */
  async sendAttachment({ to, message, mediaUrl, from, effectId = null }) {
    try {
      console.log(`📸 Sending attachment via BlueBubbles to ${to}`);
      console.log(`   Media URL: ${mediaUrl}`);
      
      let chatGuid;
      if (to.includes('@')) {
        chatGuid = to;
      } else {
        const cleanNumber = to.replace(/\D/g, '');
        const formattedNumber = cleanNumber.startsWith('0') ? cleanNumber.substring(1) : cleanNumber;
        chatGuid = `+${formattedNumber}`;
      }
      
      // Try different methods
      const methods = ['appleScript', 'api'];
      
      for (const method of methods) {
        try {
          console.log(`   Trying method: ${method}`);
          
          const payload = {
            chatGuid: chatGuid,
            message: message || '📎 Attachment',
            method: method,
            file: mediaUrl,
            effectId: effectId
          };
          
          if (from) payload.from = from;
          
          const response = await this.client.post('/message/send', payload);
          
          console.log(`   ✅ Attachment sent successfully using ${method}!`);
          
          return {
            success: true,
            guid: response.data.guid,
            messageId: response.data.guid,
            method: method,
            response: response.data
          };
          
        } catch (methodError) {
          console.log(`   ❌ Method ${method} failed:`, methodError.response?.data?.message || methodError.message);
        }
      }
      
      throw new Error('All attachment sending methods failed');
      
    } catch (error) {
      console.error(`   ❌ Failed to send attachment:`, error.message);
      throw error;
    }
  }

  /**
   * Send a message with a specific chat GUID (advanced)
   */
  async sendToChatGuid({ chatGuid, message, from, effectId = null }) {
    try {
      console.log(`📱 Sending iMessage to chat: ${chatGuid}`);
      
      const payload = {
        chatGuid: chatGuid,
        message: message,
        method: 'appleScript',
        effectId: effectId
      };
      
      if (from) payload.from = from;
      
      const response = await this.client.post('/message/send', payload);
      
      return {
        success: true,
        guid: response.data.guid,
        response: response.data
      };
      
    } catch (error) {
      console.error(`   ❌ Failed to send:`, error.message);
      throw error;
    }
  }

  /**
   * Get available chats (useful for finding chat GUIDs)
   */
  async getChats(limit = 20) {
    try {
      const response = await this.client.get(`/chats?limit=${limit}`);
      return response.data;
    } catch (error) {
      console.error('Failed to get chats:', error.message);
      return [];
    }
  }

  /**
   * Get server status
   */
  async getStatus() {
    try {
      const response = await this.client.get('/ping');
      return response.data;
    } catch (error) {
      console.error('Failed to get status:', error.message);
      return { status: 'error', message: error.message };
    }
  }

  /**
   * Send typing indicator
   */
  async sendTypingIndicator(chatGuid, isTyping = true) {
    try {
      const response = await this.client.post('/typing', {
        chatGuid: chatGuid,
        isTyping: isTyping
      });
      return response.data;
    } catch (error) {
      console.error('Failed to send typing indicator:', error.message);
      return null;
    }
  }
}

export default BlueBubblesService;