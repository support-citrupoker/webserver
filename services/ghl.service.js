// services/ghl.service.js
import { HighLevel } from '@gohighlevel/api-client';
import axios from 'axios';

class GHLService {
  constructor() {
    // Token storage
    this.locationTokens = new Map(); // locationId -> accessToken
    this.axiosInstances = new Map(); // locationId -> axios instance
    this.sdkClients = new Map(); // locationId -> SDK client
    
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
    this.clientId = process.env.GHL_CLIENT_ID;
    this.clientSecret = process.env.GHL_CLIENT_SECRET;
    
    if (this.agencyToken) {
      console.log('🔧 Initializing MULTI-LOCATION mode with agency token');
    }
    
    // Suppress SDK internal error logging for expected errors
    this._suppressSDKLogging();
    
    console.log(`📍 Default location: ${this.defaultLocationId || 'Not set'}`);
  }

  /**
   * Suppress SDK internal error logging for expected errors
   */
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

  /**
   * Register a location with its access token
   */
  registerLocation(locationId, accessToken) {
    if (!locationId || !accessToken) {
      throw new Error('Both locationId and accessToken are required');
    }
    
    this.locationTokens.set(locationId, accessToken);
    
    // Create axios instance for this location
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
    
    // Create SDK client for this location
    const sdkClient = new HighLevel({
      privateIntegrationToken: accessToken,
      apiVersion: this.apiVersion
    });
    this.sdkClients.set(locationId, sdkClient);
    
    console.log(`✅ Registered location: ${locationId}`);
  }

  /**
   * Get token for a specific location
   */
  async getLocationToken(locationId) {
    if (!locationId) throw new Error('locationId is required');
    
    // Check if we already have a token for this location
    if (this.locationTokens.has(locationId)) {
      return this.locationTokens.get(locationId);
    }
    
    // If using agency token, exchange for location-specific token
    if (this.agencyToken) {
      const locationToken = await this.exchangeForLocationToken(locationId);
      this.registerLocation(locationId, locationToken);
      return locationToken;
    }
    
    throw new Error(`No token available for location: ${locationId}. Please register this location first.`);
  }

  /**
   * Exchange agency token for location-specific token
   */
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
          headers: {
            'Content-Type': 'application/json'
          }
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
      throw new Error(`Cannot access location ${locationId}. Make sure your agency token has access to this sub-account.`);
    }
  }

  /**
   * Get SDK client for a location
   */
  async getClient(locationId = this.defaultLocationId) {
    if (!locationId) throw new Error('locationId is required');
    
    if (this.sdkClients.has(locationId)) {
      return this.sdkClients.get(locationId);
    }
    
    await this.getLocationToken(locationId);
    return this.sdkClients.get(locationId);
  }

  /**
   * Get axios instance for a location
   */
  async getAxios(locationId = this.defaultLocationId) {
    if (!locationId) throw new Error('locationId is required');
    
    if (this.axiosInstances.has(locationId)) {
      return this.axiosInstances.get(locationId);
    }
    
    await this.getLocationToken(locationId);
    return this.axiosInstances.get(locationId);
  }

  /**
   * Set or update the default location ID
   */
  setDefaultLocationId(locationId) {
    this.defaultLocationId = locationId;
    console.log(`📍 Default location ID set to: ${locationId}`);
  }

  // ==================== CONTACT METHODS ====================

  /**
   * Search contacts by phone number or email
   */
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

  /**
   * Get contact by ID
   */
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
      
      // Fallback to direct axios if SDK fails
      if (error.statusCode === 403 || error.response?.status === 403) {
        console.log('🔄 SDK failed, trying direct axios fallback...');
        const axiosInstance = await this.getAxios(locationId);
        const response = await axiosInstance.get(`/contacts/${contactId}`);
        return response.data.contact || response.data;
      }
      
      throw error;
    }
  }

  /**
   * Create a new contact - WITH SILENT DUPLICATE HANDLING
   */
  async createContact(contactData, locationId = this.defaultLocationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      // Handle both phone and email
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

      // Clean up undefined values
      Object.keys(payload).forEach(key => 
        payload[key] === undefined && delete payload[key]
      );

      const client = await this.getClient(locationId);
      const response = await client.contacts.createContact(payload);
      const contact = response.contact || response;
      
      console.log(`✅ Contact created: ${contact.id}`);
      return contact;
      
    } catch (error) {
      // Handle duplicate contact error gracefully
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

  /**
   * Update an existing contact
   */
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
        {
          headers: { 'locationId': locationId }
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
   * Create or update contact (upsert by phone or email)
   */
  async upsertContact(contactData, locationId = this.defaultLocationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`🔄 Upserting contact with identifier: ${contactData.phone || contactData.email}`);

      const result = await this.createContact(contactData, locationId);
      
      if (result._exists) {
        console.log(`📌 Found existing contact: ${result.id}`);
        
        const existingContact = await this.getContact(result.id, locationId);
        
        // Merge tags and custom fields
        const updateData = {
          firstName: contactData.firstName || existingContact.firstName,
          lastName: contactData.lastName || existingContact.lastName,
          email: contactData.email || existingContact.email,
          tags: [
            ...(existingContact.tags || []),
            ...(contactData.tags || [])
          ].filter((v, i, a) => a.indexOf(v) === i),
          source: contactData.source || existingContact.source,
          customFields: this.mergeCustomFields(
            existingContact.customFields || [],
            contactData.customFields || []
          )
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
   * Merge custom fields
   */
  mergeCustomFields(existingFields, newFields) {
    const merged = [...existingFields];
    for (const newField of newFields) {
      const index = merged.findIndex(f => f.key === newField.key);
      if (index >= 0) {
        merged[index] = newField;
      } else {
        merged.push(newField);
      }
    }
    return merged;
  }

  // ==================== CONVERSATION METHODS ====================

  /**
   * Create a conversation - WITH SILENT DUPLICATE HANDLING
   */
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

  /**
   * Add message to conversation
   */
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

      // Add attachments if present
      if (messageData.mediaUrls && messageData.mediaUrls.length > 0) {
        payload.attachments = messageData.mediaUrls;
      }

      // Add SMS-specific fields
      if (messageData.fromNumber) payload.fromNumber = messageData.fromNumber;
      if (messageData.toNumber) payload.toNumber = messageData.toNumber;

      // Add metadata
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

  /**
   * Get all messages from a conversation
   */
  async getAllConversationMessages(conversationId, locationId = this.defaultLocationId) {
    try {
      if (!locationId) throw new Error('locationId required');
      if (!conversationId) throw new Error('conversationId required');

      console.log(`📋 Fetching ALL messages for conversation: ${conversationId}`);
      
      let allMessages = [];
      let lastMessageId = null;
      let hasMore = true;
      const pageSize = 100;

      const axiosInstance = await this.getAxios(locationId);

      while (hasMore) {
        let url = `/conversations/${conversationId}/messages?limit=${pageSize}`;
        
        if (lastMessageId) {
          url += `&lastMessageId=${lastMessageId}`;
        }

        const response = await axiosInstance.get(url, {
          headers: { 'locationId': locationId }
        });
        
        const messages = response.data.messages || [];
        
        if (messages.length > 0) {
          allMessages = [...allMessages, ...messages];
          lastMessageId = messages[messages.length - 1].id;
          console.log(`📦 Fetched ${messages.length} messages (total: ${allMessages.length})`);
        }

        hasMore = messages.length === pageSize;
      }

      console.log(`✅ Retrieved ${allMessages.length} messages`);
      return allMessages;
      
    } catch (error) {
      console.error('❌ Get messages failed:', error.message);
      throw error;
    }
  }

  // ==================== HELPER METHODS ====================

  /**
   * Format phone number for GHL (E.164 format with +)
   */
  formatPhoneForGHL(phone) {
    if (!phone) return phone;
    if (phone.startsWith('+')) return phone;
    const cleaned = phone.replace(/\D/g, '');
    return `+${cleaned}`;
  }

  /**
   * Test connection for a location
   */
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

  /**
   * Get helpful error message
   */
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

  /**
   * Diagnose location access
   */
  async diagnoseLocationAccess(locationId = this.defaultLocationId) {
    console.log('\n🔍 DIAGNOSING GHL LOCATION ACCESS');
    console.log('===================================');
    console.log(`📍 Target Location ID: ${locationId}`);
    console.log(`🔑 Token exists: ${this.locationTokens.has(locationId) ? 'Yes' : 'No'}`);
    console.log(`🏢 Agency mode: ${this.agencyToken ? 'Yes' : 'No'}`);
    
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