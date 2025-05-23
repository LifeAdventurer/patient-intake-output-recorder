Vue.createApp({
  data() {
    return {
      // --- Core State ---
      account: "", // Loaded from localStorage or URL params
      password: "", // Loaded from localStorage or URL params
      authenticated: false,
      apiUrl: "", // Loaded from config.json
      events: {}, // Loaded from events.json
      records: {}, // Holds patient's fetched record data { date_key: { data: [...], ... }, controlKeys... }

      // --- Input State ---
      inputFood: 0,
      inputWater: 0,
      inputUrination: 0,
      inputDefecation: 0,
      customInputFood: "", // For custom value entry
      customInputWater: "", // For custom value entry
      customInputUrination: "", // For custom value entry
      inputWeight: "", // Use empty string for easier validation/placeholder

      // --- UI State ---
      showPassword: false,
      restrictionText: "", // Display text for intake limits
      showNotification: false, // For "Record Saved" feedback
      showScrollButton: false,
      bootstrapAlertMessage: "",
      bootstrapAlertClass: "alert-danger", // Default class
      confirmMessage: "",
      confirmResolver: null, // For Bootstrap confirm modal promise
      isInitialLoading: false, // Initial page-load state
      isPosting: false, // Generic state for API calls
      isUpdating: false, // Specific flag for updateRecords call
      isFetching: false, // Specific flag for fetchRecords call
      confirming: false, // Flag to prevent sync/actions during confirmation modal
      removingRecord: false, // Flag during record removal confirmation/API call

      // --- i18n State ---
      selectedLanguage: "en", // Default language
      supportedLanguages: [], // Loaded from supported_languages.json
      curLangTexts: {}, // Loaded from lang_texts.json

      // --- Configuration / Constants ---
      // Predefined options for quick input (consider moving to config if dynamic)
      options: [
        { value: 50, label: "50" },
        { value: 100, label: "100" },
        { value: 150, label: "150" },
        { value: 200, label: "200" },
        { value: 250, label: "250" },
        { value: 300, label: "300" },
        { value: 350, label: "350" },
        { value: 400, label: "400" },
      ],
      dietaryItems: ["food", "water", "urination", "defecation"], // For iteration
      backgroundSyncIntervalId: null,
      dateTimeIntervalId: null,

      // --- Date/Time ---
      currentDate: "", // Formatted date string for display
      currentTime: "", // Formatted time string for display
      currentDateYY_MM_DD: "", // YYYY_M_D format for record keys
    };
  },

  // --- Computed Properties ---
  computed: {
    /** Returns the translation object for the currently selected language */
    curLangText() {
      return (
        this.curLangTexts[this.selectedLanguage] ||
        this.curLangTexts["en"] ||
        {}
      ); // Fallback to English or empty object
    },

    /** Returns record data with date keys reversed for display */
    reversedRecord() {
      const reversedData = {};
      // These keys are part of the patient record but shouldn't be displayed as daily records
      const keysToFilter = [
        "isEditing",
        "limitAmount",
        "foodCheckboxChecked",
        "waterCheckboxChecked",
      ];

      Object.keys(this.records)
        .filter(
          (key) =>
            !keysToFilter.includes(key) && /^\d{4}_\d{1,2}_\d{1,2}$/.test(key),
        ) // Filter control keys and validate format
        .sort((a, b) => b.localeCompare(a)) // Sort keys descending (latest date first)
        .forEach((key) => {
          // Ensure the daily record structure exists before assigning
          if (
            this.records[key] &&
            typeof this.records[key] === "object" &&
            this.records[key].data
          ) {
            reversedData[key] = this.records[key];
          } else {
            console.warn(`Skipping invalid record structure for key: ${key}`);
          }
        });
      return reversedData;
    },
  },

  // --- Watchers ---
  watch: {
    /** Update restriction text and save language preference when changed */
    selectedLanguage(newLang, oldLang) {
      if (newLang !== oldLang) {
        localStorage.setItem("selectedLanguageCode", newLang);
        this.processRestrictionText(); // Re-process with new language strings
        this.updateDateTime(); // Update date format if language changes day names
      }
    },
    /** Re-process restriction text if the underlying record data changes */
    records: {
      handler() {
        this.processRestrictionText();
      },
      deep: true, // Watch for nested changes within the records object
    },
  },

  // --- Lifecycle Hooks ---
  async created() {
    this.isInitialLoading = true;
    // Load essential configs first
    await this.fetchConfig(); // Loads apiUrl, API events and messages
    await this.loadLanguageData(); // Loads supported languages and texts
    this.loadSelectedLanguage(); // Sets initial language based on localStorage or default
    this.updateDateTime(); // Initial date/time set

    // Attempt initial authentication (moved from mounted to ensure config is ready)
    const urlParams = new URLSearchParams(window.location.search);
    const urlAccount = urlParams.get("acct");
    const urlPassword = urlParams.get("pw");
    const sessionAccount = localStorage.getItem("patientAccount");
    const sessionPassword = localStorage.getItem("patientPassword");

    const accountToUse = urlAccount || sessionAccount;
    const passwordToUse = urlPassword || sessionPassword;

    if (accountToUse && passwordToUse) {
      this.account = accountToUse;
      this.password = passwordToUse;
      await this.authenticate(); // This fetches initial records if successful
    }
    this.isInitialLoading = false;
  },

  mounted() {
    // Set up intervals after component is mounted
    this.dateTimeIntervalId = setInterval(this.updateDateTime, 1000);
    globalThis.addEventListener("scroll", this.handleScroll);

    // Set up background data synchronization and visibility handling only if authenticated
    if (this.authenticated) {
      this.setupBackgroundSync();
    }
  },

  beforeUnmount() {
    // Clean up intervals and event listeners
    if (this.dateTimeIntervalId) clearInterval(this.dateTimeIntervalId);
    this.teardownBackgroundSync();
  },

  // --- Methods ---
  methods: {
    // --- Initialization & Configuration ---
    /**
     * Load app config (apiUrl) and event definitions.
     * @returns {Promise<void>}
     * @throws {Error} If config.json or events.json can’t be fetched or parsed.
     */
    async fetchConfig() {
      try {
        const response = await fetch("./config.json");
        if (!response.ok)
          throw new Error(`HTTP error! status: ${response.status}`);
        const config = await response.json();
        this.apiUrl = config.apiUrl;

        const eventsResponse = await fetch("./events.json");
        if (!eventsResponse.ok)
          throw new Error(`HTTP error! status: ${eventsResponse.status}`);
        this.events = await eventsResponse.json();
        console.log("Configuration and events loaded.");
      } catch (error) {
        console.error("Failed to load config.json or events.json:", error);
        this.showAlert(
          this.curLangText?.config_load_error ||
            "Failed to load configuration.",
          "danger",
        );
      }
    },
    /**
     * Load supported language list and translation texts.
     * @returns {Promise<void>}
     * @throws {Error} If supported_languages.json or lang_texts.json fails to load.
     */
    async loadLanguageData() {
      try {
        const [langResponse, textsResponse] = await Promise.all([
          fetch("./supported_languages.json"),
          fetch("./lang_texts.json"),
        ]);

        if (!langResponse.ok)
          throw new Error(
            `Failed to load supported_languages.json: ${langResponse.status}`,
          );
        this.supportedLanguages = await langResponse.json();

        if (!textsResponse.ok)
          throw new Error(
            `Failed to load lang_texts.json: ${textsResponse.status}`,
          );
        this.curLangTexts = await textsResponse.json();

        console.log("Language data loaded.");
      } catch (error) {
        console.error("Failed to load language data:", error);
        // Show alert in default language as curLangText might not be available
        this.showAlert("Failed to load language files.", "danger");
      }
    },

    loadSelectedLanguage() {
      const savedLang = localStorage.getItem("selectedLanguageCode");
      // Check if saved language is valid and loaded
      if (
        savedLang &&
        this.supportedLanguages.some((lang) => lang.code === savedLang) &&
        this.curLangTexts[savedLang]
      ) {
        this.selectedLanguage = savedLang;
      } else {
        // If invalid or not loaded, set default and save it
        this.selectedLanguage = "en"; // Ensure default exists in files
        localStorage.setItem("selectedLanguageCode", this.selectedLanguage);
      }
      console.log("Selected language set to:", this.selectedLanguage);
    },

    /** Initializes the structure for a given date if it doesn't exist */
    initRecordsIfNeeded(dateKey) {
      if (!this.records[dateKey]) {
        console.log(`Initializing records for date: ${dateKey}`);
        const dateParts = dateKey.split("_"); // Expects YYYY_M_D
        const displayDate =
          dateParts.length === 3 ? `${dateParts[1]}/${dateParts[2]}` : dateKey; // Basic formatting
        // Use Vue.set or direct assignment for reactivity. Direct should work as `records` is reactive.
        this.records[dateKey] = {
          data: [], // Array to hold individual entries { time, food, water, ... }
          count: 0,
          recordDate: displayDate, // Formatted date M/D for display
          foodSum: 0,
          waterSum: 0,
          urinationSum: 0,
          defecationSum: 0,
          weight: 0,
        };
      }
    },

    updateDateTime() {
      const d = new Date();
      const year = d.getFullYear();
      const month = d.getMonth() + 1; // JS months are 0-indexed
      const day = ("0" + d.getDate()).slice(-2);
      const hours = ("0" + d.getHours()).slice(-2);
      const minutes = ("0" + d.getMinutes()).slice(-2);
      const seconds = ("0" + d.getSeconds()).slice(-2);

      // Use language-specific day names if available
      const dayNames = this.curLangText?.day_of_week || [
        "Sun",
        "Mon",
        "Tue",
        "Wed",
        "Thu",
        "Fri",
        "Sat",
      ]; // Default/Fallback
      const dayOfWeek = dayNames[d.getDay()];

      this.currentDate = `${year}.${month}.${day} (${dayOfWeek})`;
      this.currentTime = `${hours}:${minutes}:${seconds}`;
      this.currentDateYY_MM_DD = `${year}_${month}_${day}`; // Key format
    },

    // --- API Communication ---
    /**
     * Send a POST to the configured API.
     * @param {object} payload – Must include `{ event, account, password, … }`.
     * @returns {Promise<object>} The parsed JSON response.
     * @throws {Error} On network failure or non‑OK HTTP status.
     */
    async postRequest(payload) {
      if (!this.apiUrl) {
        this.showAlert(
          this.curLangText?.api_url_missing || "API URL not configured.",
          "danger",
        );
        throw new Error("API URL is not configured.");
      }
      this.isLoading = true; // Show loading state
      try {
        const response = await fetch(this.apiUrl, {
          method: "POST",
          mode: "cors",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          let errorData = {
            message: `Request failed with status ${response.status}`,
          };
          try {
            const errorJson = await response.json();
            errorData = { ...errorData, ...errorJson }; // Merge messages if possible
          } catch (e) {
            /* Ignore if response body is not JSON */
          }
          throw new Error(errorData.message);
        }

        console.log(`API Request successful for event: ${payload?.event}`);
        return await response.json();
      } catch (error) {
        console.error("postRequest Error:", error);
        this.showAlert(
          `${this.curLangText?.api_request_failed || "API Request Failed"}: ${error.message}`,
          "danger",
        );
        throw error; // Re-throw for specific handling in calling functions
      } finally {
        this.isLoading = false; // Hide loading state
      }
    },

    /**
     * Fetch this patient’s records from the server (also serves as auth check).
     * @returns {Promise<{ message: string, account_records?: object }>}
     */
    async fetchRecords() {
      if (this.isFetching || this.isUpdating || this.confirming) {
        // console.log("Fetch skipped due to active operation.");
        return; // Don't fetch if already fetching, updating, or confirming
      }
      console.log("Fetching records...");
      this.isPosting = true;
      try {
        const payload = {
          event: this.events.FETCH_RECORD,
          account: this.account,
          password: this.password,
          patient: this.account, // Patient side fetches its own account
        };
        const fetchedData = await this.postRequest(payload);

        // Process successful fetch
        if (fetchedData.message === this.events.messages.FETCH_RECORD_SUCCESS) {
          this.records = fetchedData.account_records || {};
          // processRestrictionText is handled by the watcher now
          console.log("Records fetched successfully.");
        } else {
          // Handle specific non-success messages if needed
          console.warn(
            "Fetch records returned non-success message:",
            fetchedData.message,
          );
          // Consider showing a warning, but could be noisy for background sync
        }
        return fetchedData; // Return data for authenticate function
      } catch (error) {
        console.error("Error fetching records:", error.message);
        // Alert is shown by postRequest
        return { message: error.message }; // Return error structure for authenticate
      } finally {
        this.isPosting = false;
      }
    },

    /**
     * Push local `this.records` up to the server.
     * @returns {Promise<boolean>} True on success, false on failure.
     */
    async updateRecords() {
      if (this.isUpdating || this.isFetching) {
        console.warn("Update skipped, another update/fetch in progress.");
        return false; // Prevent concurrent updates
      }
      console.log("Updating records...");
      this.isUpdating = true;
      try {
        const payload = {
          event: this.events.UPDATE_RECORD,
          account: this.account,
          password: this.password,
          patient: this.account,
          data: this.records, // Send the entire local records object
        };
        const response = await this.postRequest(payload);

        if (response.message === this.events.messages.UPDATE_RECORD_SUCCESS) {
          console.log("Patient records updated successfully on server.");
          return true;
        } else {
          console.error(
            "Failed to update records on server:",
            response.message,
          );
          this.showAlert(
            `${this.curLangText?.update_failed || "Update Failed"}: ${response.message}`,
            "danger",
          );
          // Consider reverting local changes or re-fetching on critical failure
          // await this.fetchRecords(); // Option: Re-sync on failure
          return false;
        }
      } catch (error) {
        console.error("Error during updateRecords:", error.message);
        // Alert potentially shown by postRequest already
        return false;
      } finally {
        this.isUpdating = false;
      }
    },

    // --- Authentication ---
    async authenticate() {
      if (!this.account || !this.password) {
        this.showAlert(
          this.curLangText?.enter_credentials ||
            "Please enter account and password.",
          "danger",
        );
        return;
      }
      console.log("Attempting patient authentication for:", this.account);
      // fetchRecords doubles as the auth check here
      const fetchedData = await this.fetchRecords();

      if (fetchedData && fetchedData.message) {
        switch (fetchedData.message) {
          case this.events.messages.FETCH_RECORD_SUCCESS:
            // Success case handled within fetchRecords by setting this.records
            this.authenticated = true;
            // Store credentials in localStorage
            localStorage.setItem("patientAccount", this.account);
            localStorage.setItem("patientPassword", this.password);
            console.log("Patient authentication successful.");
            this.setupBackgroundSync(); // Start background sync after successful login
            break;
          case this.events.messages.ACCT_NOT_EXIST:
            this.showAlert(
              this.curLangText?.nonexistent_account ||
                "Account does not exist.",
              "danger",
            );
            this.resetCredentialsAndState();
            break;
          case this.events.messages.AUTH_FAIL_PASSWORD:
            this.showAlert(
              this.curLangText?.incorrect_password || "Incorrect password.",
              "danger",
            );
            this.password = "";
            localStorage.removeItem("patientPassword");
            this.authenticated = false;
            break;
          case this.events.messages.INVALID_ACCT_TYPE: // Should ideally not happen for patient login
            this.showAlert(
              this.curLangText?.account_without_permission ||
                "Account type invalid for login.",
              "danger",
            );
            this.resetCredentialsAndState();
            break;
          default:
            // Handle other specific errors or generic failure
            this.showAlert(
              `${this.curLangText?.login_failed || "Login Failed"}: ${fetchedData.message}`,
              "danger",
            );
            this.resetCredentialsAndState();
            break;
        }
      } else if (!fetchedData) {
        // Handle case where fetchRecords failed completely (e.g., network error)
        // Alert should have been shown by postRequest/fetchRecords
        this.resetCredentialsAndState();
      }
    },

    resetCredentialsAndState() {
      this.account = "";
      this.password = "";
      this.authenticated = false;
      this.records = {};
      localStorage.removeItem("patientAccount");
      localStorage.removeItem("patientPassword");
      this.stopBackgroundSyncInterval(); // Stop sync if logged out due to error
    },

    togglePasswordVisibility() {
      this.showPassword = !this.showPassword;
    },

    async confirmLogout() {
      const confirmed = await this.showConfirm(
        this.curLangText?.confirm_logout || "Confirm logout?",
      );
      if (confirmed) {
        console.log("Logging out patient:", this.account);
        this.resetCredentialsAndState();
      }
    },

    // --- Data Input & Processing ---
    /** Validates and retrieves the numeric value from standard or custom inputs */
    getNumericInput(standardValue, customValue) {
      let value = 0;
      if (standardValue === "custom") {
        // Allow empty string in custom input to mean 0 after submit attempt
        const parsed = parseInt(customValue);
        if (!isNaN(parsed) && parsed >= 0) {
          value = parsed;
        } else if (customValue !== "" && (isNaN(parsed) || parsed < 0)) {
          // Invalid custom input
          return null; // Indicate error
        }
        // If customValue is "" and standard is "custom", treat as 0
      } else {
        const parsedStandard = parseInt(standardValue);
        if (!isNaN(parsedStandard) && parsedStandard >= 0) {
          value = parsedStandard;
        }
      }
      return value;
    },

    /**
     * Validate inputs, merge into today's record, then call `updateRecords()`.
     * Displays a temporary success notification on completion.
     * @returns {Promise<void>}
     */
    async addData() {
      // 1. Validate and get numeric inputs
      const foodValue = this.getNumericInput(
        this.inputFood,
        this.customInputFood,
      );
      const waterValue = this.getNumericInput(
        this.inputWater,
        this.customInputWater,
      );
      const urinationValue = this.getNumericInput(
        this.inputUrination,
        this.customInputUrination,
      );
      const defecationValue =
        parseInt(this.inputDefecation) >= 0
          ? parseInt(this.inputDefecation)
          : 0; // Simpler for defecation (no custom)

      const weightValueStr = String(this.inputWeight).trim();
      let weightToSave = null;
      let weightError = false;

      if (weightValueStr !== "") {
        const parsedWeight = parseFloat(weightValueStr);
        if (isNaN(parsedWeight) || parsedWeight <= 0 || parsedWeight > 300) {
          // Allow 0? Validate range. Assuming > 0 and <= 300.
          weightError = true;
        } else {
          weightToSave = Math.round(parsedWeight * 100) / 100; // Round to 2 decimal places
        }
      }

      // Check for validation errors
      if (
        foodValue === null ||
        waterValue === null ||
        urinationValue === null
      ) {
        this.showAlert(
          this.curLangText?.please_enter_a_positive_integer ||
            "Custom input must be a non-negative number.",
          "danger",
        );
        return;
      }

      if (weightError) {
        this.showAlert(
          this.curLangText?.weight_abnormal ||
            "Weight input is invalid (must be > 0 and <= 300).",
          "danger",
        );
        return;
      }

      // Check if there's anything to save
      const hasDietaryData =
        foodValue > 0 ||
        waterValue > 0 ||
        urinationValue > 0 ||
        defecationValue > 0;
      const hasWeightData = weightToSave !== null;

      if (!hasDietaryData && !hasWeightData) {
        this.showAlert(
          this.curLangText?.no_data_to_submit ||
            "Please enter some data or weight to record.",
          "warning",
        );
        return; // Nothing to add
      }

      // 2. Prepare data and update records
      const d = new Date();
      const currentTimeFormatted = `${("0" + d.getHours()).slice(-2)}:${("0" + d.getMinutes()).slice(-2)}`;
      const currentDateKey = this.currentDateYY_MM_DD;

      this.initRecordsIfNeeded(currentDateKey); // Ensure today's record structure exists

      let recordUpdated = false;

      // Add dietary data if present
      if (hasDietaryData) {
        const currentDietaryData = {
          time: currentTimeFormatted,
          food: foodValue,
          water: waterValue,
          urination: urinationValue,
          defecation: defecationValue,
        };
        const dailyDataArray = this.records[currentDateKey].data;

        // Merging Logic (ensure robustness)
        const lastRecord = dailyDataArray.pop();
        if (lastRecord && lastRecord.time === currentDietaryData.time) {
          console.log("Merging with last record at time:", lastRecord.time);
          this.dietaryItems.forEach((item) => {
            lastRecord[item] =
              (lastRecord[item] || 0) + currentDietaryData[item];
          });
          dailyDataArray.push(lastRecord); // Push merged record back
        } else {
          if (lastRecord) dailyDataArray.push(lastRecord); // Push previous back if different time
          dailyDataArray.push(currentDietaryData); // Push new record
        }
        // // --- Simplified Add Logic (No Merging) ---
        // dailyDataArray.push(currentDietaryData);
        // console.log("Added new dietary record:", currentDietaryData);

        // Update sums and count
        this.records[currentDateKey].count = dailyDataArray.length;
        this.records[currentDateKey].foodSum += foodValue;
        this.records[currentDateKey].waterSum += waterValue;
        this.records[currentDateKey].urinationSum += urinationValue;
        this.records[currentDateKey].defecationSum += defecationValue;
        recordUpdated = true;
      }

      // Update weight if present
      if (hasWeightData) {
        // Weight is stored per day, not per entry
        this.records[currentDateKey].weight = weightToSave; // Store the numeric value
        console.log(
          `Updated weight for ${currentDateKey} to: ${weightToSave} kg`,
        );
        recordUpdated = true;
      }

      // 3. Reset inputs
      this.inputFood = 0;
      this.inputWater = 0;
      this.inputUrination = 0;
      this.inputDefecation = 0;
      this.customInputFood = "";
      this.customInputWater = "";
      this.customInputUrination = "";
      this.inputWeight = "";

      // 4. Update backend if changes were made
      if (recordUpdated) {
        if (await this.updateRecords()) {
          // Show success notification
          this.showNotification = true;
          setTimeout(() => {
            this.showNotification = false;
          }, 2000);
        }
      }
    },

    /** Processes and updates the restriction text display */
    processRestrictionText() {
      // Ensure records and language text are loaded
      if (
        !this.records ||
        typeof this.records !== "object" ||
        !this.curLangText ||
        Object.keys(this.curLangText).length === 0
      ) {
        this.restrictionText = ""; // Consider a loading/default message
        return;
      }

      const limitAmountStr = String(this.records.limitAmount ?? "").trim();
      const foodChecked = this.records.foodCheckboxChecked ?? false;
      const waterChecked = this.records.waterCheckboxChecked ?? false;
      let text = "";
      if (
        limitAmountStr !== "" &&
        !isNaN(parseInt(limitAmountStr)) &&
        parseInt(limitAmountStr) >= 0 &&
        (foodChecked || waterChecked)
      ) {
        const limitAmount = parseFloat(limitAmountStr);
        const parts = [];
        if (foodChecked && waterChecked) {
          parts.push(
            this.curLangText?.limit_food_and_water_to_no_more_than ||
              "Limit Food+Water <",
          );
        } else if (foodChecked) {
          parts.push(
            this.curLangText?.limit_food_to_no_more_than || "Limit Food <",
          );
        } else {
          // Only water checked
          parts.push(
            this.curLangText?.limit_water_to_no_more_than || "Limit Water <",
          );
        }
        parts.push(limitAmount);
        parts.push(this.curLangText?.grams || "g/ml"); // Use a generic unit
        text = parts.join(" "); // Add spaces between parts
      } else {
        // Leave text as empty string, so the alert will not display
      }
      this.restrictionText = text;
    },

    /** Determines color for food sum based on restrictions */
    getFoodSumColor() {
      const todayRecord = this.records?.[this.currentDateYY_MM_DD];
      if (
        !todayRecord ||
        !this.records.foodCheckboxChecked ||
        !this.records.limitAmount ||
        isNaN(parseInt(this.records.limitAmount))
      ) {
        return "inherit";
      }
      const limit = parseInt(this.records.limitAmount);
      const foodSum = todayRecord.foodSum ?? 0;
      const waterSum = todayRecord.waterSum ?? 0;
      const total =
        foodSum + (this.records.waterCheckboxChecked ? waterSum : 0);
      return total >= limit ? "red" : "inherit";
    },

    /** Determines color for water sum based on restrictions */
    getWaterSumColor() {
      const todayRecord = this.records?.[this.currentDateYY_MM_DD];
      if (
        !todayRecord ||
        !this.records.waterCheckboxChecked ||
        !this.records.limitAmount ||
        isNaN(parseInt(this.records.limitAmount))
      ) {
        return "inherit";
      }
      const limit = parseInt(this.records.limitAmount);
      const foodSum = todayRecord.foodSum ?? 0;
      const waterSum = todayRecord.waterSum ?? 0;
      const total = waterSum + (this.records.foodCheckboxChecked ? foodSum : 0);
      return total >= limit ? "red" : "inherit";
    },

    // --- Record Management ---
    async removeRecord(target) {
      if (
        !target ||
        !target.attributes ||
        !target.attributes.id ||
        this.removingRecord ||
        this.confirming
      ) {
        console.warn(
          "Remove skipped: Invalid target or operation already in progress.",
        );
        return;
      }
      const idParts = target.attributes.id.textContent.split("-");
      if (idParts.length !== 2) {
        console.error(
          "Invalid record ID format for removal:",
          target.attributes.id.textContent,
        );
        return;
      }
      const [dateKey, indexStr] = idParts;
      const index = parseInt(indexStr);

      if (!this.records?.[dateKey]?.data?.[index]) {
        console.error("Record data not found for removal:", dateKey, index);
        return;
      }

      const recordToRemove = this.records[dateKey].data[index];

      // Show confirmation
      this.confirming = true;
      const confirmed = await this.showConfirm(
        this.curLangText?.confirm_remove_record ||
          "Confirm remove this record? This action cannot be undone.",
      );
      this.confirming = false;
      if (!confirmed) {
        console.log("Record removal cancelled.");
        return;
      }

      // Proceed with removal
      console.log(`Removing record at index ${index} for date ${dateKey}`);
      this.removingRecord = true;

      try {
        // Update local sums *before* removing
        const dailyRecord = this.records[dateKey];
        dailyRecord.count = Math.max(0, dailyRecord.count - 1);
        this.dietaryItems.forEach((item) => {
          const value = recordToRemove[item] ?? 0;
          dailyRecord[`${item}Sum`] = Math.max(
            0,
            (dailyRecord[`${item}Sum`] || 0) - value,
          );
        });

        // Remove from local array
        dailyRecord.data.splice(index, 1);

        // Update backend
        await this.updateRecords();
        this.showAlert(
          this.curLangText?.record_removed_successfully || "Record removed.",
          "success",
        );
      } catch (error) {
        console.error("Error during record removal:", error);
        // Alert potentially shown by updateRecords or postRequest
        // Consider adding a specific removal error message or re-fetching to sync state
        await this.fetchRecords(); // Re-sync on error
      } finally {
        this.removingRecord = false;
      }
    },

    // --- UI Helpers ---
    /**
     * Displays a Bootstrap alert message.
     * @param {string} message - The message to display.
     * @param {'success' | 'danger' | 'warning' | 'info'} type - The alert type (default: 'success').
     * @param {number} duration - How long the alert stays visible in ms (default: 3000).
     */
    showAlert(message, type = "success", duration = 5000) {
      // Use language strings if available
      const msg = this.curLangText?.[message] || message;

      this.bootstrapAlertMessage = msg;
      switch (type) {
        case "danger":
          this.bootstrapAlertClass = "alert-danger";
          break;
        case "warning":
          this.bootstrapAlertClass = "alert-warning";
          break;
        case "info":
          this.bootstrapAlertClass = "alert-info";
          break;
        case "success":
        default:
          this.bootstrapAlertClass = "alert-success";
          break;
      }
      // Clear previous timeout if any
      if (this.alertTimeoutId) clearTimeout(this.alertTimeoutId);
      // Set new timeout
      this.alertTimeoutId = setTimeout(() => {
        this.bootstrapAlertMessage = "";
        this.alertTimeoutId = null;
      }, duration);
    },

    /**
     * Shows a confirmation modal and returns a promise that resolves with the user's choice.
     * @param {string} message - The message to display in the modal body.
     * @returns {Promise<boolean>} - Resolves true if confirmed, false otherwise.
     */
    showConfirm(message) {
      const msg = this.curLangText?.[message] || message; // Translate message if key exists
      this.confirmMessage = msg;
      this.confirming = true; // Set flag

      return new Promise((resolve) => {
        this.confirmResolver = resolve;
        const modalElement = document.getElementById("confirmModal");
        if (modalElement) {
          const modal = bootstrap.Modal.getOrCreateInstance(modalElement);
          const handleModalClose = () => {
            if (this.confirmResolver) {
              this.confirmResolver(false); // Resolve false if closed without button
              this.confirmResolver = null;
            }
            this.confirming = false; // Reset flag
            modalElement.removeEventListener(
              "hidden.bs.modal",
              handleModalClose,
            );
          };
          modalElement.addEventListener("hidden.bs.modal", handleModalClose, {
            once: true,
          });
          modal.show();
        } else {
          console.error("Confirm modal element not found.");
          resolve(false); // Fail safely
          this.confirming = false;
        }
      });
    },

    handleConfirm(result) {
      // Resolve the promise stored in showConfirm
      if (this.confirmResolver) {
        this.confirmResolver(result);
        this.confirmResolver = null;
      }
      // Flag is reset by hidden.bs.modal listener in showConfirm
    },

    changeLanguage(languageCode) {
      if (this.supportedLanguages.some((lang) => lang.code === languageCode)) {
        this.selectedLanguage = languageCode;
        // Watcher will handle localStorage update and text processing
      } else {
        console.warn(
          `Attempted to change to unsupported language: ${languageCode}`,
        );
      }
    },

    scrollToTop() {
      globalThis.scrollTo({
        top: 0,
        behavior: "smooth",
      });
    },

    handleScroll() {
      this.showScrollButton = globalThis.scrollY > 200; // Show after scrolling down a bit more
    },

    // --- Background Sync ---
    setupBackgroundSync() {
      document.addEventListener(
        "visibilitychange",
        this.handleVisibilityChange,
      );
      this.handleVisibilityChange(); // Run once to set initial state
    },

    startBackgroundSyncInterval() {
      if (this.backgroundSyncIntervalId === null && this.authenticated) {
        console.log("Starting background sync interval...");
        // Run fetch immediately once, then set interval
        this.fetchRecords();
        // Fetch records periodically
        this.backgroundSyncIntervalId = setInterval(this.fetchRecords, 3000);
      }
    },

    stopBackgroundSyncInterval() {
      if (this.backgroundSyncIntervalId !== null) {
        console.log("Stopping background sync interval.");
        clearInterval(this.backgroundSyncIntervalId);
        this.backgroundSyncIntervalId = null;
      }
    },

    handleVisibilityChange() {
      if (!this.authenticated) return; // Only run if logged in

      if (document.hidden) {
        console.log("Page hidden, stopping background sync.");
        this.stopBackgroundSyncInterval(); // Clear interval when tab is hidden
      } else {
        console.log("Page visible, starting background sync.");
        this.startBackgroundSyncInterval(); // Start interval (will fetch once immediately)
      }
    },

    teardownBackgroundSync() {
      this.stopBackgroundSyncInterval();
      document.removeEventListener(
        "visibilitychange",
        this.handleVisibilityChange,
      );
    },
  }, // End Methods
}).mount("#app");
