// services/ghl.service.js
import { HighLevel } from '@gohighlevel/api-client';
import axios from 'axios';

class GHLService {
  constructor() {
    // Initialize the SDK client
    this.client = new HighLevel({
      privateIntegrationToken: process.env.GHL_PRIVATE_INTEGRATION_TOKEN,
      apiVersion: process.env.GHL_API_VERSION || '2021-07-28'
    });
    
    // Also create an axios instance for direct calls
    this.apiVersion = process.env.GHL_API_VERSION || '2021-07-28';
    this.accessToken = process.env.GHL_PRIVATE_INTEGRATION_TOKEN;
    this.baseURL = 'https://services.leadconnectorhq.com';
    
    this.axios = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        'Version': this.apiVersion
      }
    });
    
    // Store locationId from environment
    this.locationId = process.env.GHL_LOCATION_ID;
    
    // Suppress SDK internal error logging for expected errors
    this._suppressSDKLogging();
    
    console.log('🔧 GHL Client initialized');
    console.log(`📍 Default locationId: ${this.locationId ? 'Set' : 'Not set'}`);
  }

  /**
   * Suppress SDK internal error logging for expected errors
   */
  _suppressSDKLogging() {
    const originalError = console.error;
    console.error = (...args) => {
      const errorMsg = args.join(' ');
      if (errorMsg.includes('duplicated contacts') || 
          errorMsg.includes('Conversation already exists')) {
        return;
      }
      originalError.apply(console, args);
    };
  }

  /**
   * Set or update the location ID
   */
  setLocationId(locationId) {
    this.locationId = locationId;
    console.log(`📍 Location ID set to: ${locationId}`);
  }

  // ==================== CONTACT METHODS ====================

  /**
   * Search contacts by phone number
   */
  async searchContactsByPhone(phoneNumber, locationId = this.locationId) {
    try {
      if (!locationId) {
        throw new Error('locationId is required');
      }

      console.log(`🔍 Searching contact with phone: ${phoneNumber}`);

      const cleanPhone = phoneNumber.replace(/\D/g, '');
      
      const response = await this.client.contacts.searchContactsAdvanced({
        locationId: locationId,
        pageLimit: 10,
        filters: [{
          field: "phone",
          operator: "contains",
          value: cleanPhone
        }]
      });

      const contacts = response.contacts || [];
      console.log(`✅ Found ${contacts.length} contacts`);
      return contacts;
    } catch (error) {
      console.debug('🔍 Search returned no results');
      return [];
    }
  }

  /**
   * Get contact by ID
   */
  async getContact(contactId, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');
      
      console.log(`👤 Fetching contact: ${contactId}`);
      
      const response = await this.client.contacts.getContact(
        { contactId },
        { headers: { locationId } }
      );
      
      return response.contact || response;
    } catch (error) {
      console.error('❌ Get contact failed:', error.message);
      throw error;
    }
  }

  /**
   * Create a new contact - WITH SILENT DUPLICATE HANDLING
   */
  async createContact(contactData, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      const formattedPhone = this.formatPhoneForGHL(contactData.phone);

      const payload = {
        locationId: locationId,
        firstName: contactData.firstName || '',
        lastName: contactData.lastName || '',
        name: contactData.name || `${contactData.firstName || ''} ${contactData.lastName || ''}`.trim(),
        phone: formattedPhone,
        ...(contactData.email && contactData.email.trim() !== '' ? { email: contactData.email } : {}),
        address1: contactData.address1 || '',
        city: contactData.city || '',
        state: contactData.state || '',
        postalCode: contactData.postalCode || '',
        country: contactData.country || 'US',
        website: contactData.website || '',
        timezone: contactData.timezone || 'America/New_York',
        tags: contactData.tags || ['tallbob_contact'],
        source: contactData.source || 'Tall Bob Integration',
        customFields: contactData.customFields || []
      };

      Object.keys(payload).forEach(key => 
        payload[key] === undefined && delete payload[key]
      );

      const response = await this.client.contacts.createContact(payload);
      const contact = response.contact || response;
      return contact;
    } catch (error) {
      if (error.statusCode === 400 && 
          error.response?.message === 'This location does not allow duplicated contacts.' &&
          error.response?.meta?.contactId) {
        
        return {
          id: error.response.meta.contactId,
          name: error.response.meta.contactName,
          _exists: true,
          _matchingField: error.response.meta.matchingField
        };
      }
      throw error;
    }
  }

  /**
   * Update an existing contact - USING DIRECT AXIOS
   */
  async updateContact(contactId, contactData, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`✏️ Updating contact: ${contactId}`);

      const payload = {};
      
      if (contactData.firstName) payload.firstName = contactData.firstName;
      if (contactData.lastName) payload.lastName = contactData.lastName;
      if (contactData.email && contactData.email.trim() !== '') payload.email = contactData.email;
      if (contactData.phone) payload.phone = contactData.phone;
      if (contactData.tags && Array.isArray(contactData.tags)) payload.tags = contactData.tags;
      if (contactData.source) payload.source = contactData.source;
      if (contactData.customFields && Array.isArray(contactData.customFields)) {
        payload.customFields = contactData.customFields;
      }

      console.log('Update payload:', JSON.stringify(payload, null, 2));

      const response = await this.axios.put(
        `/contacts/${contactId}`,
        payload,
        {
          headers: {
            'locationId': locationId
          }
        }
      );

      console.log(`✅ Contact updated: ${contactId}`);
      return response.data.contact || response.data;
    } catch (error) {
      console.error('❌ Update contact failed:', error.message);
      throw error;
    }
  }

  /**
   * Create or update contact (upsert by phone)
   */
  async upsertContact(contactData, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`🔄 Upserting contact with phone: ${contactData.phone}`);

      const result = await this.createContact(contactData, locationId);
      
      if (result._exists) {
        console.log(`📌 Found existing contact: ${result.id}`);
        
        const existingContact = await this.getContact(result.id, locationId);
        
        const updateData = {
          firstName: contactData.firstName || existingContact.firstName,
          lastName: contactData.lastName || existingContact.lastName,
          email: contactData.email || existingContact.email,
          tags: [
            ...(existingContact.tags || []),
            ...(contactData.tags || [])
          ].filter((v, i, a) => a.indexOf(v) === i),
          source: contactData.source || existingContact.source,
          customFields: [
            ...(existingContact.customFields || []),
            ...(contactData.customFields || [])
          ]
        };

        const updated = await this.updateContact(result.id, updateData, locationId);
        return { contact: updated, action: 'updated' };
      }
      
      return { contact: result, action: 'created' };
      
    } catch (error) {
      console.error('❌ Upsert failed:', error.message);
      throw error;
    }
  }

  /**
   * Check if a phone number exists
   */
  async phoneExists(phoneNumber, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      const testContact = {
        phone: phoneNumber,
        firstName: 'Temp',
        lastName: 'Temp',
        tags: ['temp_check']
      };

      const result = await this.createContact(testContact, locationId);
      
      if (result._exists) {
        return {
          exists: true,
          contactId: result.id,
          contactName: result.name,
          matchingField: result._matchingField
        };
      }
      
      return { exists: false };
      
    } catch (error) {
      return { exists: false, error: error.message };
    }
  }

  /**
   * Get contact by phone number
   */
  async getContactByPhone(phoneNumber, locationId = this.locationId) {
    try {
      const result = await this.phoneExists(phoneNumber, locationId);
      
      if (result.exists && result.contactId) {
        return await this.getContact(result.contactId, locationId);
      }
      
      return null;
    } catch (error) {
      return null;
    }
  }

  // ==================== TAG METHODS ====================

  /**
   * Add tag to contact
   */
  async addTagToContact(contactId, tag, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      const response = await this.client.contacts.addTag(
        { contactId, tag },
        { headers: { locationId } }
      );

      return response;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Remove tag from contact
   */
  async removeTagFromContact(contactId, tag, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      const response = await this.client.contacts.removeTag(
        { contactId, tag },
        { headers: { locationId } }
      );

      return response;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ==================== CUSTOM FIELD METHODS ====================

  /**
   * Update custom field for contact
   */
  async updateCustomField(contactId, fieldKey, fieldValue, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      const response = await this.client.contacts.updateCustomFields(
        { 
          contactId,
          customFields: [{ key: fieldKey, value: fieldValue }]
        },
        { headers: { locationId } }
      );

      return response;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ==================== NOTE METHODS ====================

  /**
   * Add note to contact
   */
  async addNote(contactId, note, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      const response = await this.client.contacts.addNote(
        { contactId, body: note },
        { headers: { locationId } }
      );

      return response;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get notes for contact
   */
  async getNotes(contactId, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      const response = await this.client.contacts.getNotes(
        { contactId },
        { headers: { locationId } }
      );

      return response.notes || [];
    } catch (error) {
      return [];
    }
  }

  // ==================== CONVERSATION METHODS ====================

  /**
   * Create a conversation - WITH SILENT DUPLICATE HANDLING
   */
  async createConversation(contactId, type = 'SMS', locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      const response = await this.client.conversations.createConversation({
        contactId,
        locationId,
        type
      });

      return response.conversation || response;
    } catch (error) {
      if (error.statusCode === 400 && 
          error.response?.message === 'Conversation already exists' &&
          error.response?.conversationId) {
        
        return {
          id: error.response.conversationId,
          _exists: true
        };
      }
      throw error;
    }
  }

  /**
   * Get or create conversation
   */
  async getOrCreateConversation(contactId, type = 'SMS', locationId = this.locationId) {
    try {
      const conversation = await this.createConversation(contactId, type, locationId);
      return {
        conversation,
        action: conversation._exists ? 'existing' : 'created'
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Add message to conversation - FIXED to handle attachments properly
   */
  async addMessageToConversation(conversationId, messageData, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');
      if (!messageData.contactId) throw new Error('contactId is required');

      console.log(`📝 Adding message to conversation: ${conversationId}`);

      // Build base payload
      const payload = {
        type: messageData.messageType || 'SMS',
        conversationId: conversationId,
        contactId: messageData.contactId,
        message: messageData.body,
        direction: messageData.direction || 'inbound',
        date: messageData.date || new Date().toISOString()
      };

      // Only add attachments if they actually exist
      if (messageData.mediaUrls && messageData.mediaUrls.length > 0) {
        payload.attachments = messageData.mediaUrls;
      }

      // Add SMS-specific fields if provided
      if (messageData.fromNumber) payload.fromNumber = messageData.fromNumber;
      if (messageData.toNumber) payload.toNumber = messageData.toNumber;

      console.log('Message payload:', JSON.stringify(payload, null, 2));

      const response = await this.client.conversations.addAnInboundMessage(payload);

      console.log(`✅ Message added: ${response.id || response.messageId}`);
      return {
        id: response.id || response.messageId,
        conversationId: response.conversationId || conversationId
      };
    } catch (error) {
      console.error('❌ Add message failed:', error.message);
      throw error;
    }
  }

  /**
   * Get conversation messages (single page)
   */
  async getConversationMessages(conversationId, locationId = this.locationId, limit = 20) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`📋 Fetching messages for conversation: ${conversationId}`);

      const response = await this.client.conversations.getMessages({
        conversationId: conversationId,
        limit: limit,
        type: 'TYPE_SMS,TYPE_CALL'
      });

      console.log(`✅ Retrieved messages`);
      return response.messages || [];
    } catch (error) {
      console.error('❌ Get messages failed:', error.message);
      return [];
    }
  }

 /**
 * Get ALL messages from a conversation (handles pagination automatically)
 * @param {string} conversationId - The conversation ID
 * @param {string} locationId - Location ID (optional)
 * @param {string} messageTypes - Types of messages to fetch (default: all types)
 * @returns {Promise<Array>} Array of all messages
 */
async getAllConversationMessages(conversationId, locationId = this.locationId, messageTypes = 'TYPE_CALL, TYPE_SMS, TYPE_EMAIL, TYPE_FACEBOOK, TYPE_GMB, TYPE_INSTAGRAM, TYPE_WHATSAPP, TYPE_ACTIVITY_APPOINTMENT, TYPE_ACTIVITY_CONTACT, TYPE_ACTIVITY_INVOICE, TYPE_ACTIVITY_PAYMENT, TYPE_ACTIVITY_OPPORTUNITY, TYPE_LIVE_CHAT, TYPE_INTERNAL_COMMENTS, TYPE_ACTIVITY_EMPLOYEE_ACTION_LOG') {
  try {
    if (!locationId) throw new Error('locationId required');
    if (!conversationId) throw new Error('conversationId required');

    console.log(`📋 Fetching ALL messages for conversation: ${conversationId}`);
    
    let allMessages = [];
    let lastMessageId = null;
    let hasMore = true;
    const pageSize = 100; // Maximum allowed per page

    while (hasMore) {
      // Build request parameters
      const params = {
        conversationId: conversationId,
        limit: pageSize,
        type: "TYPE_INTERNAL_COMMENTS"
      };

      // Add lastMessageId for pagination if we have it
      if (lastMessageId) {
        params.lastMessageId = lastMessageId;
      }

      // Make the API call
      const response = await this.client.conversations.getMessages(params);
      const messages = response.messages || [];
      
      if (messages.length > 0) {
        allMessages = [...allMessages, ...messages];
        lastMessageId = messages[messages.length - 1].id;
        console.log(`📦 Fetched ${messages.length} messages (total: ${allMessages.length})`);
      }

      // Check if there might be more messages
      hasMore = messages.length === pageSize;
    }

    console.log(`✅ Retrieved all ${allMessages.length} messages from conversation ${conversationId}`);
    return allMessages;
  } catch (error) {
    console.error('❌ Get all conversation messages failed:', error.message);
    throw error;
  }
  }

  /**
   * Check if a conversation exists
   */
  async conversationExists(contactId, locationId = this.locationId) {
    try {
      const result = await this.createConversation(contactId, 'SMS', locationId);
      return {
        exists: !!result._exists,
        conversationId: result._exists ? result.id : null
      };
    } catch (error) {
      return { exists: false };
    }
  }

  // ==================== LOCATION METHODS ====================

  /**
   * Get location details
   */
  async getLocation(locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      const response = await this.client.locations.getLocation(
        { locationId },
        { preferredTokenType: 'location' }
      );

      return response.location || response;
    } catch (error) {
      throw error;
    }
  }

  // ==================== HELPER METHODS ====================

  /**
   * Format phone number for GHL (E.164 format with +)
   */
  formatPhoneForGHL(phone) {
    if (!phone) return phone;
    const cleaned = phone.replace(/\D/g, '');
    return `+${cleaned}`;
  }

  /**
   * Test connection
   */
  async testConnection(locationId = this.locationId) {
    try {
      if (!locationId) {
        return { success: false, error: 'No locationId provided' };
      }

      const response = await this.client.contacts.searchContactsAdvanced({
        locationId: locationId,
        pageLimit: 1
      });

      return {
        success: true,
        message: 'GHL connection successful',
        hasContacts: (response.contacts?.length || 0) > 0
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

export default GHLService;