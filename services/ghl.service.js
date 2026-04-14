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

  setLocationId(locationId) {
    this.locationId = locationId;
  }

  // ==================== CONTACT METHODS ====================

  async searchContactsByPhone(phoneNumber, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      const isEmail = phoneNumber.includes('@');
      const cleanIdentifier = isEmail ? phoneNumber.toLowerCase().trim() : phoneNumber.replace(/\D/g, '');
      
      const filters = isEmail 
        ? [{ field: "email", operator: "contains", value: cleanIdentifier }]
        : [{ field: "phone", operator: "contains", value: cleanIdentifier }];
      
      const response = await this.client.contacts.searchContactsAdvanced({
        locationId: locationId,
        pageLimit: 10,
        filters: filters
      });

      return response.contacts || [];
    } catch (error) {
      return [];
    }
  }

  async getContact(contactId, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');
      
      const response = await this.client.contacts.getContact(
        { contactId },
        { headers: { locationId } }
      );
      
      return response.contact || response;
    } catch (error) {
      throw error;
    }
  }

  async createContact(contactData, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      let formattedPhone = null;
      let formattedEmail = null;
      
      if (contactData.phone) {
        formattedPhone = this.formatPhoneForGHL(contactData.phone);
      }
      
      if (contactData.email && contactData.email.trim() !== '') {
        formattedEmail = contactData.email.toLowerCase().trim();
      }

      const payload = {
        locationId: locationId,
        firstName: contactData.firstName || '',
        lastName: contactData.lastName || '',
        name: contactData.name || `${contactData.firstName || ''} ${contactData.lastName || ''}`.trim(),
        ...(formattedPhone && { phone: formattedPhone }),
        ...(formattedEmail && { email: formattedEmail }),
        address1: contactData.address1 || '',
        city: contactData.city || '',
        state: contactData.state || '',
        postalCode: contactData.postalCode || '',
        country: contactData.country || 'US',
        website: contactData.website || '',
        timezone: contactData.timezone || 'America/New_York',
        tags: contactData.tags || ['incoming_contact'],
        source: contactData.source || 'Message Integration',
        customFields: contactData.customFields || []
      };

      Object.keys(payload).forEach(key => 
        payload[key] === undefined && delete payload[key]
      );

      const response = await this.client.contacts.createContact(payload);
      return response.contact || response;
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

  async updateContact(contactId, contactData, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      const payload = {};
      
      if (contactData.firstName) payload.firstName = contactData.firstName;
      if (contactData.lastName) payload.lastName = contactData.lastName;
      if (contactData.email && contactData.email.trim() !== '') payload.email = contactData.email;
      if (contactData.phone) payload.phone = this.formatPhoneForGHL(contactData.phone);
      if (contactData.tags && Array.isArray(contactData.tags)) payload.tags = contactData.tags;
      if (contactData.source) payload.source = contactData.source;
      if (contactData.customFields && Array.isArray(contactData.customFields)) {
        payload.customFields = contactData.customFields;
      }

      const response = await this.axios.put(
        `/contacts/${contactId}`,
        payload,
        { headers: { 'locationId': locationId } }
      );

      return response.data.contact || response.data;
    } catch (error) {
      throw error;
    }
  }

  async upsertContact(contactData, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      const result = await this.createContact(contactData, locationId);
      
      if (result._exists) {
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
          ].reduce((acc, curr) => {
            const existing = acc.find(f => f.key === curr.key);
            if (!existing) acc.push(curr);
            return acc;
          }, [])
        };

        const updated = await this.updateContact(result.id, updateData, locationId);
        return { contact: updated, action: 'updated' };
      }
      
      return { contact: result, action: 'created' };
    } catch (error) {
      throw error;
    }
  }

  async contactExists(identifier, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      const isEmail = identifier.includes('@');
      const testContact = {
        ...(isEmail ? { email: identifier } : { phone: identifier }),
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

  async getContactByIdentifier(identifier, locationId = this.locationId) {
    try {
      const result = await this.contactExists(identifier, locationId);
      if (result.exists && result.contactId) {
        return await this.getContact(result.contactId, locationId);
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  // ==================== TAG METHODS ====================

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

  async updateCustomField(contactId, fieldKey, fieldValue, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');
      const response = await this.client.contacts.updateCustomFields(
        { contactId, customFields: [{ key: fieldKey, value: fieldValue }] },
        { headers: { locationId } }
      );
      return response;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ==================== NOTE METHODS ====================

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

  async createConversation(contactId, type = 'SMS', locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');
      const response = await this.client.conversations.createConversation({
        contactId,
        locationId,
        type: type === 'iMessage' ? 'SMS' : type
      });
      return response.conversation || response;
    } catch (error) {
      if (error.statusCode === 400 && 
          error.response?.message === 'Conversation already exists' &&
          error.response?.conversationId) {
        return { id: error.response.conversationId, _exists: true };
      }
      throw error;
    }
  }

  async getOrCreateConversation(contactId, type = 'SMS', locationId = this.locationId) {
    try {
      const conversation = await this.createConversation(contactId, type, locationId);
      return { conversation, action: conversation._exists ? 'existing' : 'created' };
    } catch (error) {
      throw error;
    }
  }

  async addMessageToConversation(conversationId, messageData, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');
      if (!messageData.contactId) throw new Error('contactId is required');

      const payload = {
        type: messageData.messageType === 'iMessage' ? 'SMS' : (messageData.messageType || 'SMS'),
        conversationId: conversationId,
        contactId: messageData.contactId,
        message: messageData.body || '',
        direction: messageData.direction || 'inbound',
        date: messageData.date || new Date().toISOString()
      };

      if (messageData.mediaUrls && messageData.mediaUrls.length > 0) {
        payload.attachments = messageData.mediaUrls;
      }

      if (messageData.fromNumber) payload.fromNumber = messageData.fromNumber;
      if (messageData.toNumber) payload.toNumber = messageData.toNumber;

      if (messageData.providerMessageId) {
        payload.metadata = {
          provider: messageData.provider || 'unknown',
          providerMessageId: messageData.providerMessageId,
          originalTimestamp: messageData.date
        };
      }

      const response = await this.client.conversations.addAnInboundMessage(payload);
      return {
        id: response.id || response.messageId,
        conversationId: response.conversationId || conversationId
      };
    } catch (error) {
      throw error;
    }
  }

  async getConversationMessages(conversationId, locationId = this.locationId, limit = 20) {
    try {
      if (!locationId) throw new Error('locationId required');
      const response = await this.client.conversations.getMessages({
        conversationId: conversationId,
        limit: limit,
        type: 'TYPE_SMS,TYPE_CALL'
      });
      return response.messages || [];
    } catch (error) {
      return [];
    }
  }

  async getAllConversationMessages(conversationId, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');
      if (!conversationId) throw new Error('conversationId required');
      
      let allMessages = [];
      let lastMessageId = null;
      let hasMore = true;
      const pageSize = 100;

      while (hasMore) {
        let url = `/conversations/${conversationId}/messages?limit=${pageSize}`;
        if (lastMessageId) url += `&lastMessageId=${lastMessageId}`;

        const response = await this.axios.get(url, {
          headers: { 'locationId': locationId }
        });
        
        const messages = response.data.messages || [];
        if (messages.length > 0) {
          allMessages = [...allMessages, ...messages];
          lastMessageId = messages[messages.length - 1].id;
        }
        hasMore = messages.length === pageSize;
      }
      return allMessages;
    } catch (error) {
      throw error;
    }
  }

  async searchConversations({ 
    contactId, 
    locationId = this.locationId,
    limit = 20,
    query = '',
    sort = 'desc',
    sortBy = 'last_message_date',
    lastMessageType = '',
    lastMessageDirection = '',
    status = 'all',
    startAfterDate = null,
    id = null
  }) {
    try {
      if (!locationId) throw new Error('locationId required');
      if (!contactId) throw new Error('contactId required');

      const searchParams = {
        locationId: locationId,
        contactId: contactId,
        limit: limit,
        sort: sort,
        sortBy: sortBy,
        status: status
      };

      if (query) searchParams.query = query;
      if (lastMessageType) searchParams.lastMessageType = lastMessageType;
      if (lastMessageDirection) searchParams.lastMessageDirection = lastMessageDirection;
      if (startAfterDate) searchParams.startAfterDate = startAfterDate;
      if (id) searchParams.id = id;

      const response = await this.client.conversations.searchConversation(searchParams);
      return response.conversations || [];
    } catch (error) {
      throw error;
    }
  }

  async getContactConversationsWithMessages(contactId, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');
      if (!contactId) throw new Error('contactId required');
      
      const conversations = await this.searchConversations({ contactId, locationId, limit: 100 });
      const conversationsWithMessages = [];
      
      for (const conv of conversations) {
        const messages = await this.getAllConversationMessages(conv.id, locationId);
        conversationsWithMessages.push({
          id: conv.id,
          type: conv.type,
          createdAt: conv.createdAt,
          lastMessageAt: conv.lastMessageAt,
          lastMessageBody: conv.lastMessageBody,
          lastMessageType: conv.lastMessageType,
          lastMessageDirection: conv.lastMessageDirection,
          unreadCount: conv.unreadCount || 0,
          participants: conv.participants || [],
          messageCount: messages.length,
          messages: messages
        });
      }
      
      conversationsWithMessages.sort((a, b) => {
        const dateA = a.lastMessageAt || a.createdAt;
        const dateB = b.lastMessageAt || b.createdAt;
        return new Date(dateB) - new Date(dateA);
      });
      
      return { contactId, conversationCount: conversationsWithMessages.length, conversations: conversationsWithMessages };
    } catch (error) {
      throw error;
    }
  }

  async conversationExists(contactId, locationId = this.locationId) {
    try {
      const result = await this.createConversation(contactId, 'SMS', locationId);
      return { exists: !!result._exists, conversationId: result._exists ? result.id : null };
    } catch (error) {
      return { exists: false };
    }
  }

  // ==================== LOCATION METHODS ====================

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

  formatPhoneForGHL(phone) {
    if (!phone) return phone;
    if (phone.startsWith('+')) return phone;
    const cleaned = phone.replace(/\D/g, '');
    return `+${cleaned}`;
  }

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