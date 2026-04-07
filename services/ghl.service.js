// services/ghl.service.js
import { HighLevel } from '@gohighlevel/api-client';
import axios from 'axios';

class GHLService {
  constructor() {
    // Token storage
    this.locationTokens = new Map();
    this.axiosInstances = new Map();
    this.sdkClients = new Map();
    
    // Config
    this.apiVersion = process.env.GHL_API_VERSION || '2021-07-28';
    this.defaultLocationId = process.env.GHL_LOCATION_ID;
    
    // Single location mode (private integration)
    if (process.env.GHL_PRIVATE_INTEGRATION_TOKEN && this.defaultLocationId) {
      console.log('🔧 Initializing SINGLE LOCATION mode');
      this.registerLocation(this.defaultLocationId, process.env.GHL_PRIVATE_INTEGRATION_TOKEN);
    }
    
    // Multi-location mode (agency OAuth)
    this.agencyToken = process.env.GHL_AGENCY_TOKEN;
    
    if (this.agencyToken) {
      console.log('🔧 Initializing MULTI-LOCATION mode with agency token');
    }
    
    // Suppress SDK internal error logging
    this._suppressSDKLogging();
    
    console.log(`📍 Default location: ${this.defaultLocationId || 'Not set'}`);
  }

  _suppressSDKLogging() {
    const originalError = console.error;
    console.error = (...args) => {
      const errorMsg = args.join(' ');
      if (errorMsg.includes('duplicated contacts') || 
          errorMsg.includes('Conversation already exists') ||
          errorMsg.includes('token does not have access')) {
        return;
      }
      originalError.apply(console, args);
    };
  }

  registerLocation(locationId, accessToken) {
    if (!locationId || !accessToken) {
      throw new Error('Both locationId and accessToken are required');
    }
    
    this.locationTokens.set(locationId, accessToken);
    
    const axiosInstance = axios.create({
      baseURL: 'https://services.leadconnectorhq.com',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Version': this.apiVersion,
        'LocationId': locationId
      },
      timeout: 30000
    });
    
    this.axiosInstances.set(locationId, axiosInstance);
    
    const sdkClient = new HighLevel({
      privateIntegrationToken: accessToken,
      apiVersion: this.apiVersion
    });
    this.sdkClients.set(locationId, sdkClient);
    
    console.log(`✅ Registered location: ${locationId}`);
  }

  async getLocationToken(locationId) {
    if (!locationId) throw new Error('locationId is required');
    
    if (this.locationTokens.has(locationId)) {
      return this.locationTokens.get(locationId);
    }
    
    if (this.agencyToken) {
      const locationToken = await this.exchangeForLocationToken(locationId);
      this.registerLocation(locationId, locationToken);
      return locationToken;
    }
    
    throw new Error(`No token available for location: ${locationId}`);
  }

  async exchangeForLocationToken(locationId) {
    try {
      console.log(`🔄 Exchanging agency token for location: ${locationId}`);
      
      const response = await axios.post(
        'https://services.leadconnectorhq.com/oauth/location/token',
        {
          agencyAccessToken: this.agencyToken,
          locationId: locationId
        },
        {
          headers: { 'Content-Type': 'application/json' }
        }
      );
      
      if (!response.data.access_token) {
        throw new Error('No access token in response');
      }
      
      console.log(`✅ Obtained token for location: ${locationId}`);
      return response.data.access_token;
      
    } catch (error) {
      console.error(`❌ Failed to get token for location ${locationId}:`, 
                    error.response?.data?.message || error.message);
      throw new Error(`Cannot access location ${locationId}`);
    }
  }

  async getClient(locationId = this.defaultLocationId) {
    if (!locationId) throw new Error('locationId is required');
    
    if (this.sdkClients.has(locationId)) {
      return this.sdkClients.get(locationId);
    }
    
    await this.getLocationToken(locationId);
    return this.sdkClients.get(locationId);
  }

  async getAxios(locationId = this.defaultLocationId) {
    if (!locationId) throw new Error('locationId is required');
    
    if (this.axiosInstances.has(locationId)) {
      return this.axiosInstances.get(locationId);
    }
    
    await this.getLocationToken(locationId);
    return this.axiosInstances.get(locationId);
  }

  setDefaultLocationId(locationId) {
    this.defaultLocationId = locationId;
    console.log(`📍 Default location ID set to: ${locationId}`);
  }

  // ==================== CONTACT METHODS ====================

  async searchContactsByPhone(identifier, locationId = this.defaultLocationId) {
    try {
      if (!locationId) throw new Error('locationId is required');

      console.log(`🔍 Searching contact with identifier: ${identifier} in location: ${locationId}`);

      const client = await this.getClient(locationId);
      const isEmail = identifier.includes('@');
      const cleanIdentifier = isEmail ? identifier.toLowerCase().trim() : identifier.replace(/\D/g, '');
      
      const filters = isEmail 
        ? [{ field: "email", operator: "contains", value: cleanIdentifier }]
        : [{ field: "phone", operator: "contains", value: cleanIdentifier }];
      
      const response = await client.contacts.searchContactsAdvanced({
        locationId: locationId,
        pageLimit: 10,
        filters: filters
      });

      const contacts = response.contacts || [];
      console.log(`✅ Found ${contacts.length} contacts`);
      return contacts;
    } catch (error) {
      console.debug('🔍 Search returned no results:', error.message);
      return [];
    }
  }

  async getContact(contactId, locationId = this.defaultLocationId) {
    if (!locationId) throw new Error('locationId required');
    if (!contactId) throw new Error('contactId required');
    
    try {
      console.log(`👤 Fetching contact: ${contactId} from location: ${locationId}`);
      
      const client = await this.getClient(locationId);
      const response = await client.contacts.getContact(
        { contactId },
        { headers: { locationId } }
      );
      
      return response.contact || response;
      
    } catch (error) {
      console.error('❌ Get contact failed:', error.message);
      
      if (error.statusCode === 403 || error.response?.status === 403) {
        console.log('🔄 SDK failed, trying direct axios fallback...');
        const axiosInstance = await this.getAxios(locationId);
        const response = await axiosInstance.get(`/contacts/${contactId}`);
        return response.data.contact || response.data;
      }
      
      throw error;
    }
  }

  async createContact(contactData, locationId = this.defaultLocationId) {
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

      const client = await this.getClient(locationId);
      const response = await client.contacts.createContact(payload);
      const contact = response.contact || response;
      
      console.log(`✅ Contact created: ${contact.id}`);
      return contact;
      
    } catch (error) {
      if (error.statusCode === 400 && 
          error.response?.message === 'This location does not allow duplicated contacts.' &&
          error.response?.meta?.contactId) {
        
        console.log(`📌 Contact already exists: ${error.response.meta.contactId}`);
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

  async updateContact(contactId, contactData, locationId = this.defaultLocationId) {
    try {
      if (!locationId) throw new Error('locationId required');
      if (!contactId) throw new Error('contactId required');

      console.log(`✏️ Updating contact: ${contactId} in location: ${locationId}`);

      const payload = {};
      
      if (contactData.firstName !== undefined) payload.firstName = contactData.firstName;
      if (contactData.lastName !== undefined) payload.lastName = contactData.lastName;
      if (contactData.email && contactData.email.trim() !== '') payload.email = contactData.email;
      if (contactData.phone) payload.phone = this.formatPhoneForGHL(contactData.phone);
      if (contactData.tags && Array.isArray(contactData.tags)) payload.tags = contactData.tags;
      if (contactData.source) payload.source = contactData.source;
      if (contactData.customFields && Array.isArray(contactData.customFields)) {
        payload.customFields = contactData.customFields;
      }

      const axiosInstance = await this.getAxios(locationId);
      const response = await axiosInstance.put(
        `/contacts/${contactId}`,
        payload,
        { headers: { 'locationId': locationId } }
      );

      console.log(`✅ Contact updated: ${contactId}`);
      return response.data.contact || response.data;
      
    } catch (error) {
      console.error('❌ Update contact failed:', error.message);
      throw error;
    }
  }

  // ==================== CONVERSATION METHODS ====================

  async searchConversations({ contactId, locationId = this.defaultLocationId, limit = 20, query = '', sort = 'desc', sortBy = 'last_message_date', lastMessageType = '', lastMessageDirection = '', status = 'all', startAfterDate = null, id = null }) {
    try {
      if (!locationId) throw new Error('locationId required');
      if (!contactId) throw new Error('contactId required');

      console.log(`🔍 Searching conversations for contact: ${contactId} in location: ${locationId}`);

      const client = await this.getClient(locationId);
      
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

      const response = await client.conversations.searchConversation(searchParams);
      
      const conversations = response.conversations || [];
      console.log(`✅ Found ${conversations.length} conversations`);
      
      return conversations;
    } catch (error) {
      console.error('❌ Search conversations failed:', error.message);
      
      try {
        console.log('🔄 Trying fallback search with direct axios...');
        const axiosInstance = await this.getAxios(locationId);
        const response = await axiosInstance.post('/conversations/search', {
          locationId: locationId,
          contactId: contactId,
          limit: limit,
          sort: sort,
          sortBy: sortBy,
          status: status
        });
        
        return response.data.conversations || [];
      } catch (fallbackError) {
        console.error('❌ Fallback also failed:', fallbackError.message);
        throw error;
      }
    }
  }

  async getConversationMessages(conversationId, locationId = this.defaultLocationId, limit = 20) {
    try {
      if (!locationId) throw new Error('locationId required');
      if (!conversationId) throw new Error('conversationId required');

      console.log(`📋 Fetching messages for conversation: ${conversationId}`);

      const client = await this.getClient(locationId);
      
      const response = await client.conversations.getMessages({
        conversationId: conversationId,
        limit: limit,
        type: 'TYPE_SMS,TYPE_CALL'
      });

      console.log(`✅ Retrieved messages`);
      return response.messages || [];
    } catch (error) {
      console.error('❌ Get messages failed:', error.message);
      
      try {
        console.log('🔄 Trying fallback with direct axios...');
        const axiosInstance = await this.getAxios(locationId);
        const response = await axiosInstance.get(`/conversations/${conversationId}/messages?limit=${limit}`);
        return response.data.messages || [];
      } catch (fallbackError) {
        console.error('❌ Fallback failed:', fallbackError.message);
        return [];
      }
    }
  }

  async createConversation(contactId, type = 'SMS', locationId = this.defaultLocationId) {
    try {
      if (!locationId) throw new Error('locationId required');
      if (!contactId) throw new Error('contactId required');

      const client = await this.getClient(locationId);
      const response = await client.conversations.createConversation({
        contactId,
        locationId,
        type: type === 'iMessage' ? 'SMS' : type
      });

      return response.conversation || response;
      
    } catch (error) {
      if (error.statusCode === 400 && 
          error.response?.message === 'Conversation already exists' &&
          error.response?.conversationId) {
        
        console.log(`📌 Conversation already exists: ${error.response.conversationId}`);
        return {
          id: error.response.conversationId,
          _exists: true
        };
      }
      throw error;
    }
  }

  async addMessageToConversation(conversationId, messageData, locationId = this.defaultLocationId) {
    try {
      if (!locationId) throw new Error('locationId required');
      if (!conversationId) throw new Error('conversationId required');
      if (!messageData.contactId) throw new Error('contactId is required');

      console.log(`📝 Adding message to conversation: ${conversationId}`);

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

      const client = await this.getClient(locationId);
      const response = await client.conversations.addAnInboundMessage(payload);

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

  // ==================== HELPER METHODS ====================

  formatPhoneForGHL(phone) {
    if (!phone) return phone;
    if (phone.startsWith('+')) return phone;
    const cleaned = phone.replace(/\D/g, '');
    return `+${cleaned}`;
  }

  async testConnection(locationId = this.defaultLocationId) {
    try {
      if (!locationId) {
        return { success: false, error: 'No locationId provided' };
      }

      console.log(`🧪 Testing connection for location: ${locationId}`);

      const client = await this.getClient(locationId);
      const response = await client.contacts.searchContactsAdvanced({
        locationId: locationId,
        pageLimit: 1
      });

      return {
        success: true,
        message: 'GHL connection successful',
        hasContacts: (response.contacts?.length || 0) > 0,
        locationId: locationId
      };
      
    } catch (error) {
      console.error('❌ Connection test failed:', error.message);
      return {
        success: false,
        error: error.message,
        locationId: locationId,
        suggestion: this.getErrorMessage(error, locationId)
      };
    }
  }

  getErrorMessage(error, locationId) {
    if (error.message.includes('token does not have access')) {
      return `Your token doesn't have access to location: ${locationId}. 
      
SOLUTION:
1. Go to GHL → Select the correct sub-account (${locationId})
2. Go to Settings → Integrations → Private Integrations
3. Create a NEW private integration token
4. Copy the new token to your .env file as GHL_PRIVATE_INTEGRATION_TOKEN
5. Make sure GHL_LOCATION_ID=${locationId} matches exactly
6. Restart your application`;
    }
    
    if (error.message.includes('401') || error.message.includes('Unauthorized')) {
      return 'Your token is invalid or expired. Generate a new private integration token.';
    }
    
    return 'Check your GHL_PRIVATE_INTEGRATION_TOKEN and GHL_LOCATION_ID in .env file';
  }

  async diagnoseLocationAccess(locationId = this.defaultLocationId) {
    console.log('\n🔍 DIAGNOSING GHL LOCATION ACCESS');
    console.log('===================================');
    console.log(`📍 Target Location ID: ${locationId}`);
    
    const result = await this.testConnection(locationId);
    
    if (result.success) {
      console.log('✅ CONNECTION SUCCESSFUL!');
      console.log(`📊 Has contacts: ${result.hasContacts}`);
    } else {
      console.log('❌ CONNECTION FAILED');
      console.log(`📝 Error: ${result.error}`);
      console.log(`💡 Suggestion: ${result.suggestion}`);
    }
    
    console.log('===================================\n');
    return result;
  }
}

export default GHLService;