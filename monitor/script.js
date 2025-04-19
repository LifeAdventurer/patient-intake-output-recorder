function debounce(func, delay) {
  let timeoutId;
  return function (...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      func.apply(this, args);
    }, delay);
  };
}

Vue.createApp({
  data() {
    return {
      // --- Core State ---
      account: localStorage.getItem("account") || "",
      password: localStorage.getItem("password") || "",
      authenticated: false,
      apiUrl: "",
      webUrl: "",
      events: {}, // Loaded from events.json

      // --- UI State ---
      showPassword: false,
      bootstrapAlertMessage: "",
      bootstrapAlertClass: "alert-danger", // Default class
      confirmMessage: "",
      confirmResolver: null, // For Bootstrap confirm modal promise
      showScrollButton: false,

      // --- Patient Data ---
      patientRecords: {}, // { patientAccount: { date_key: { data: [], count: 0, ...sums }, filterKeys... } }
      patientAccountsWithPasswords: [], // [[account, password], ...]
      unmonitoredPatients: [], // [account, ...]
      searchQuery: "",
      filteredPatientAccounts: [], // Derived from patientAccounts based on searchQuery

      // --- Editing / Interaction State ---
      editingRecordIndex: -1, // Index of the record being edited within a date's data array
      editingRecordPatientAccount: "", // Which patient's record is being edited
      tempPatientRecord: {}, // Holds original values while editing a record
      isEditingRestriction: false, // Is any restriction currently being edited?
      currentEditingPatient: "", // Which patient's restriction is being edited
      removingRecord: false, // Flag during record removal confirmation/API call
      confirming: false, // Flag to prevent sync during confirmation modal
      restrictionText: {},

      // --- QR Code Modal State ---
      qrCodePatient: "",
      qrCodePatientPassword: "",

      // --- Sign Up Modal State ---
      signUpPatientAccount: "",
      signUpPatientPassword: "",
      signUpPatientSubmitted: false,
      signUpAlertMessage: "",
      signUpAlertClass: "",
      stayOpenAfterSignup:
        localStorage.getItem("stayOpenAfterSignup") === "true",
      autoAddToMonitor: localStorage.getItem("autoAddToMonitor") === "true",

      // --- Transfer Modal State ---
      transferFrom: "",
      transferTo: "",

      // --- Internal Configuration / Constants ---
      syncIntervalId: null,
      dietaryItems: ["food", "water", "urination", "defecation"],
      // Keys added to each patient record if missing, also used for filtering in computed prop
      // NOTE: 'isEditing' here is specific to the *restriction* editing state stored per patient
      keysToFilter: {
        isEditing: false,
        limitAmount: "",
        foodCheckboxChecked: false,
        waterCheckboxChecked: false,
      },

      // --- Date/Time ---
      currentDate: "", // Formatted date string for display
      currentTime: "", // Formatted time string for display
      currentDateYY_MM_DD: "", // YYYY_M_D format for record keys
    };
  },

  // --- Computed Properties ---
  // Used for deriving data reactively from the main state
  computed: {
    // Returns patient records with date keys reversed for display (newest first)
    // Filters out the special 'keysToFilter' properties
    reversedPatientRecords() {
      const reversedData = {};
      for (const patientAccount in this.patientRecords) {
        const patientData = this.patientRecords[patientAccount];
        const reversedRecord = {};
        Object.keys(patientData)
          .filter((key) => !this.keysToFilter.hasOwnProperty(key)) // Filter out control keys
          .sort((a, b) => b.localeCompare(a)) // Sort keys descending (latest date first)
          .forEach((key) => {
            reversedRecord[key] = patientData[key];
          });
        reversedData[patientAccount] = reversedRecord;
      }
      return reversedData;
    },

    // Read-only list of monitored patient accounts
    monitoredPatientAccounts() {
      return this.patientAccountsWithPasswords.map((account) => account[0]);
    },
  },

  // --- Watchers ---
  // Used for reacting to specific data changes, often for side effects like localStorage
  watch: {
    stayOpenAfterSignup(newVal) {
      localStorage.setItem("stayOpenAfterSignup", newVal);
    },
    autoAddToMonitor(newVal) {
      localStorage.setItem("autoAddToMonitor", newVal);
    },
    // Update filtered list when the main list or search query changes
    monitoredPatientAccounts() {
      this.filterPatients(); // Re-filter if the source list changes
    },
    searchQuery() {
      this.filterPatients(); // Re-filter when search query changes
    },
  },

  // --- Lifecycle Hooks ---
  // Code to run at specific points in the component's lifecycle
  async created() {
    // Fetch essential config before doing anything else
    await this.fetchConfig();
    await this.loadAPIEvents();

    // Attempt initial authentication if credentials exist
    if (this.account && this.password) {
      await this.authenticate(); // This will fetch data if successful
    }

    // Set up date/time updates
    this.updateDateTime();
    this.dateTimeInterval = setInterval(this.updateDateTime, 1000);

    // Set up data synchronization and visibility handling
    if (this.authenticated) {
      this.setupSync();
    }
  },

  mounted() {
    // Add scroll listener after component is mounted
    globalThis.addEventListener("scroll", this.handleScroll);

    // Check URL parameters for credentials (alternative login method)
    const urlParams = new URLSearchParams(window.location.search);
    const urlAccount = urlParams.get("acct");
    const urlPassword = urlParams.get("pw");

    if (
      urlAccount &&
      urlPassword &&
      (!this.authenticated || this.account !== urlAccount)
    ) {
      console.log("Authenticating via URL parameters...");
      this.account = urlAccount;
      this.password = urlPassword;
      // Clear local storage if using URL params
      localStorage.removeItem("account");
      localStorage.removeItem("password");
      this.authenticate(); // Re-authenticate with URL params
    }
  },

  beforeUnmount() {
    // Clean up intervals and event listeners to prevent memory leaks
    clearInterval(this.dateTimeInterval);
    this.stopSyncInterval();
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    globalThis.removeEventListener("scroll", this.handleScroll);
  },

  // --- Methods ---
  // Actions triggered by user interactions or internal logic
  methods: {
    // --- Initialization & Configuration ---
    async fetchConfig() {
      try {
        const response = await fetch("./config.json");
        if (!response.ok)
          throw new Error(`HTTP error! status: ${response.status}`);
        const config = await response.json();
        this.apiUrl = config.apiUrl;
        this.webUrl = config.webUrl;
        console.log("Configuration loaded.");
      } catch (error) {
        console.error("Failed to load config.json:", error);
        this.showAlert("無法載入應用程式設定，請稍後再試。", "danger");
        // Potentially halt application initialization here if config is critical
      }
    },

    async loadAPIEvents() {
      try {
        const response = await fetch("./events.json");
        if (!response.ok)
          throw new Error(`HTTP error! status: ${response.status}`);
        this.events = await response.json();
        console.log("API events loaded.");
      } catch (error) {
        console.error("Failed to load events.json:", error);
        this.showAlert("無法載入 API 事件設定，請稍後再試。", "danger");
        // Potentially halt application initialization here if events are critical
      }
    },

    updateDateTime() {
      const d = new Date();
      const dayOfWeek = ["日", "一", "二", "三", "四", "五", "六"];
      const year = d.getFullYear();
      const month = d.getMonth() + 1; // JS months are 0-indexed
      const day = ("0" + d.getDate()).slice(-2);
      const hours = ("0" + d.getHours()).slice(-2);
      const minutes = ("0" + d.getMinutes()).slice(-2);
      const seconds = ("0" + d.getSeconds()).slice(-2);

      this.currentDate = `${year}.${month}.${day} (${dayOfWeek[d.getDay()]})`;
      this.currentTime = `${hours}:${minutes}:${seconds}`;
      // Consistent key format, ensuring month is not zero-padded if single digit
      this.currentDateYY_MM_DD = `${year}_${month}_${day}`;
    },

    // --- API Communication ---
    async postRequest(payload) {
      if (!this.apiUrl) {
        throw new Error("API URL is not configured.");
      }
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
          // Try to get more specific error from response body if possible
          let errorData;
          try {
            errorData = await response.json();
          } catch (jsonError) {
            // If response is not JSON or empty
            throw new Error(
              `HTTP error ${response.status}: ${response.statusText}`,
            );
          }
          // Use message from API response if available
          const errorMessage =
            errorData?.message ||
            `API request failed with status ${response.status}`;
          throw new Error(errorMessage);
        }

        console.log("API Request successful for event:", payload?.event); // Log success
        return await response.json();
      } catch (error) {
        console.error("postRequest Error:", error);
        // Re-throw the processed error for calling function to handle
        throw error;
      }
    },

    // --- Authentication ---
    async authenticate() {
      if (!this.account || !this.password) {
        this.showAlert("請輸入帳號和密碼。", "danger");
        return;
      }
      console.log("Attempting authentication for:", this.account);

      try {
        const payload = {
          event: this.events.FETCH_MONITORING_PATIENTS,
          account: this.account,
          password: this.password,
        };
        const fetchedData = await this.postRequest(payload);

        if (
          fetchedData.message &&
          fetchedData.message !==
            this.events.messages.FETCH_MONITORING_PATIENTS_SUCCESS
        ) {
          switch (fetchedData.message) {
            case this.events.messages.ACCT_NOT_EXIST:
              this.showAlert("帳號不存在", "danger");
              this.resetCredentials();
              break;
            case this.events.messages.AUTH_FAIL_PASSWORD:
              this.showAlert("密碼錯誤", "danger");
              this.password = ""; // Clear only password
              break;
            case this.events.messages.INVALID_ACCT_TYPE:
              this.showAlert("此帳號沒有管理權限", "danger");
              this.resetCredentials();
              break;
            default:
              // Handle other potential non-success messages
              this.showAlert(`驗證失敗: ${fetchedData.message}`, "danger");
              this.resetCredentials();
          }
          this.authenticated = false;
        } else {
          // Authentication Success
          this.authenticated = true;
          localStorage.setItem("account", this.account);
          localStorage.setItem("password", this.password);

          this.processFetchedData(fetchedData);
          await this.fetchUnmonitoredPatients(); // Fetch unmonitored list
          this.filterPatients(); // Initial filter after getting data
          this.setupSync(); // Start syncing data
        }
      } catch (error) {
        console.error("Authentication failed:", error);
        this.showAlert(`登入時發生錯誤: ${error.message}`, "danger");
        this.authenticated = false;
        // Consider reset credentials on network/other errors too
        // this.resetCredentials();
      }
    },

    resetCredentials() {
      this.account = "";
      this.password = "";
      localStorage.removeItem("account");
      localStorage.removeItem("password");
    },

    async confirmLogout() {
      const confirmed = await this.showConfirm("請確認是否要登出?");
      if (confirmed) {
        console.log("Logging out user:", this.account);
        this.authenticated = false;
        this.resetCredentials();
        this.patientRecords = {};
        this.patientAccountsWithPasswords = [];
        this.unmonitoredPatients = [];
        this.filteredPatientAccounts = [];
        this.stopSyncInterval(); // Stop syncing on logout
      }
    },

    togglePasswordVisibility() {
      this.showPassword = !this.showPassword;
    },

    // --- Data Synchronization & Processing ---
    setupSync() {
      if (this.authenticated) {
        document.addEventListener(
          "visibilitychange",
          this.handleVisibilityChange,
        );
        this.handleVisibilityChange(); // Run once to set initial state
      }
    },

    /** Processes data fetched from the FETCH_MONITORING_PATIENTS event */
    processFetchedData(fetchedData) {
      if (
        !fetchedData ||
        !fetchedData.patient_records ||
        !fetchedData.patient_accounts
      ) {
        console.error(
          "Invalid data received in processFetchedData:",
          fetchedData,
        );
        this.showAlert("從伺服器接收到的資料格式不正確。", "danger");
        return;
      }

      this.patientRecords = fetchedData.patient_records;
      this.patientAccountsWithPasswords = fetchedData.patient_accounts;
      // NOTE: monitoredPatientAccounts computed property will update automatically

      // Ensure essential filter/control keys exist for each patient
      this.monitoredPatientAccounts.forEach(async (patientAccount) => {
        let modified = false;
        if (!this.patientRecords[patientAccount]) {
          console.warn(
            `No record found for patient ${patientAccount} during processing, initializing.`,
          );
          this.patientRecords[patientAccount] = {}; // Initialize if missing
        }
        const record = this.patientRecords[patientAccount];
        for (const key in this.keysToFilter) {
          if (!(key in record)) {
            record[key] = this.keysToFilter[key]; // Assign default value
            modified = true;
            console.log(
              `Added missing key '${key}' for patient ${patientAccount}`,
            );
          }
        }
        // Update restriction text based on potentially newly added/existing keys
        this.updateRestrictionText(patientAccount);

        // Persist changes ONLY if defaults were added
        if (modified) {
          console.log(
            `Updating records for ${patientAccount} after adding default keys.`,
          );
          await this.updateRecords(patientAccount, record); // Update backend with the defaults
        }
      });
      console.log("Patient data processed.");
    },

    /** Checks if data synchronization can proceed */
    canSyncData() {
      if (!this.authenticated) return false;
      if (this.isEditingRestriction) return false; // Don't sync while editing restriction details
      if (this.editingRecordIndex !== -1) return false; // Don't sync while editing a specific record row
      if (this.confirming) return false; // Don't sync while a confirmation modal is active
      if (this.removingRecord) return false; // Don't sync while actively removing a record (API call in progress)
      // Add other conditions if needed
      return true;
    },

    /** Fetches latest monitored patient data if conditions allow */
    async syncMonitorData() {
      if (!this.canSyncData()) {
        // console.log("Sync skipped due to active user interaction.");
        return;
      }

      // console.log("Syncing monitor data...");
      try {
        const payload = {
          event: this.events.FETCH_MONITORING_PATIENTS,
          account: this.account,
          password: this.password,
        };
        const fetchedData = await this.postRequest(payload);

        // Double-check condition *after* await, in case state changed
        if (
          this.canSyncData() &&
          fetchedData.message ===
            this.events.messages.FETCH_MONITORING_PATIENTS_SUCCESS
        ) {
          this.processFetchedData(fetchedData);
          // No need to call filterPatients here, watcher will handle it if monitoredPatientAccounts changes
        } else if (
          fetchedData.message &&
          fetchedData.message !==
            this.events.messages.FETCH_MONITORING_PATIENTS_SUCCESS
        ) {
          // Handle potential errors during sync (e.g., permissions changed)
          console.warn("Sync failed with message:", fetchedData.message);
          // Maybe show a less intrusive alert or handle specific errors like re-authentication needed
          this.showAlert(`資料同步失敗: ${fetchedData.message}`, "warning"); // Use warning level
          if (
            fetchedData.message === this.events.messages.AUTH_FAIL_PASSWORD ||
            fetchedData.message === this.events.messages.ACCT_NOT_EXIST
          ) {
            this.authenticated = false; // Force re-login
            this.stopSyncInterval();
          }
        }
      } catch (error) {
        console.error("Error during syncMonitorData:", error);
        // Avoid spamming alerts on intermittent network errors during sync
        // this.showAlert(`資料同步時發生錯誤: ${error.message}`, "danger");
      } finally {
        // Always try to fetch the unmonitored list, even if monitored sync fails/is skipped
        // Unless authentication itself failed
        if (this.authenticated) {
          await this.fetchUnmonitoredPatients();
        }
      }
    },

    startSyncInterval() {
      if (this.syncIntervalId === null && this.authenticated) {
        console.log("Starting sync interval...");
        // Run immediately once, then set interval
        this.syncMonitorData();
        this.syncIntervalId = setInterval(this.syncMonitorData, 3000); // Sync every 3 seconds
      }
    },

    stopSyncInterval() {
      if (this.syncIntervalId !== null) {
        console.log("Stopping sync interval.");
        clearInterval(this.syncIntervalId);
        this.syncIntervalId = null;
      }
    },

    handleVisibilityChange() {
      if (!this.authenticated) return; // Don't sync if not logged in

      if (document.hidden) {
        this.stopSyncInterval();
      } else {
        this.startSyncInterval(); // This will call syncMonitorData immediately
      }
    },

    /** Updates the entire record data for a specific patient on the backend */
    async updateRecords(
      patientAccount,
      record = this.patientRecords[patientAccount],
    ) {
      if (!record) {
        console.error(
          `Attempted to update records for ${patientAccount}, but no record data found.`,
        );
        return;
      }
      console.log(`Sending update for ${patientAccount}...`);
      try {
        const payload = {
          event: this.events.UPDATE_RECORD,
          account: this.account,
          password: this.password,
          patient: patientAccount,
          data: record, // Send the entire patient record object
        };
        const { message } = await this.postRequest(payload);

        if (message === this.events.messages.UPDATE_RECORD_SUCCESS) {
          console.log(`Successfully updated records for ${patientAccount}.`);
          // Consider to provide subtle feedback on success
        } else {
          console.error(
            `Failed to update records for ${patientAccount}: ${message}`,
          );
          this.showAlert(
            `更新 ${patientAccount} 的紀錄時失敗: ${message}`,
            "danger",
          );
          // Potentially revert local changes or re-sync to get server state
          await this.syncMonitorData();
        }
      } catch (error) {
        console.error(`Error updating records for ${patientAccount}:`, error);
        this.showAlert(
          `更新 ${patientAccount} 紀錄時發生網路錯誤: ${error.message}`,
          "danger",
        );
        // Potentially revert local changes or re-sync
        await this.syncMonitorData();
      }
    },

    // --- Patient Management ---
    async fetchUnmonitoredPatients() {
      if (!this.authenticated) return;
      // console.log("Fetching unmonitored patients...");
      try {
        const payload = {
          event: this.events.FETCH_UNMONITORED_PATIENTS,
          account: this.account,
          password: this.password,
        };
        const response = await this.postRequest(payload);

        if (
          response.message ===
          this.events.messages.FETCH_UNMONITORED_PATIENTS_SUCCESS
        ) {
          this.unmonitoredPatients =
            response.unmonitored_patients?.map((p) => p[1]) || [];
          // console.log("Unmonitored patients updated:", this.unmonitoredPatients);
        } else {
          console.error(
            "Failed to fetch unmonitored patients:",
            response.message,
          );
          this.showAlert(
            `無法獲取未監測病患列表: ${response.message}`,
            "warning",
          );
        }
      } catch (error) {
        console.error("Error fetching unmonitored patients:", error);
        // Avoid alert spamming for this background fetch
        // this.showAlert(`獲取未監測病患列表時發生錯誤: ${error.message}`, "danger");
      }
    },

    async addPatientToMonitor(patientAccount) {
      if (!patientAccount) return;
      console.log(`Adding patient ${patientAccount} to monitor list...`);
      try {
        const payload = {
          event: this.events.ADD_PATIENT,
          account: this.account,
          password: this.password,
          patient: patientAccount,
        };
        const { message } = await this.postRequest(payload);

        if (message === this.events.messages.ADD_PATIENT_SUCCESS) {
          console.log(`Patient ${patientAccount} added successfully.`);
          this.showAlert(`已成功將 ${patientAccount} 加入監測列表`, "success");
          // Refresh both lists after adding
          await this.syncMonitorData(); // Gets monitored list (including new one)
          // fetchUnmonitored is called within syncMonitorData's finally block
        } else {
          console.error(`Failed to add patient ${patientAccount}: ${message}`);
          this.showAlert(
            `將 ${patientAccount} 加入監測列表時失敗: ${message}`,
            "danger",
          );
        }
      } catch (error) {
        console.error(`Error adding patient ${patientAccount}:`, error);
        this.showAlert(
          `將 ${patientAccount} 加入監測列表時發生錯誤: ${error.message}`,
          "danger",
        );
      }
    },

    async removePatientFromMonitor(patientAccount) {
      if (!patientAccount) return;

      console.log(`Removing patient ${patientAccount} from monitor list...`);
      try {
        // Find the patient's password needed for the API call
        const payload = {
          event: this.events.REMOVE_PATIENT,
          account: this.account,
          password: this.password,
          patient: patientAccount,
        };

        const { message } = await this.postRequest(payload);

        if (message === this.events.messages.REMOVE_PATIENT_SUCCESS) {
          console.log(`Patient ${patientAccount} removed from monitoring.`);
          this.showAlert(
            `已成功將 ${patientAccount} 從監測列表移除`,
            "success",
          );
          // Refresh lists
          await this.syncMonitorData();
        } else {
          console.error(
            `Failed to remove ${patientAccount} from monitoring: ${message}`,
          );
          this.showAlert(
            `從監測列表移除 ${patientAccount} 時失敗: ${message}`,
            "danger",
          );
        }
      } catch (error) {
        console.error(
          `Error removing ${patientAccount} from monitoring:`,
          error,
        );
        this.showAlert(
          `移除 ${patientAccount} 時發生錯誤: ${error.message}`,
          "danger",
        );
      }
    },

    async deletePatient(patientAccount) {
      if (!patientAccount) return;

      const confirmed = await this.showConfirm(
        `請確認病患: ${patientAccount} 是否要出院?\n這將清除該病患的所有紀錄且無法復原！\n\n如果您只是想暫時停止監測，請使用「移除監測」功能。`,
      );
      if (!confirmed) return;

      // Consider second confirmation for safety (For destructive actions)
      // const finalConfirmation = prompt(`請輸入病患帳號 "${patientAccount}" 以確認刪除：`);
      // if (finalConfirmation !== patientAccount) {
      //     this.showAlert("取消刪除操作。", "info");
      //     return;
      // }

      console.log(`Deleting patient ${patientAccount}...`);
      try {
        const patientInfo = this.patientAccountsWithPasswords.find(
          (p) => p[0] === patientAccount,
        );
        if (!patientInfo) {
          throw new Error("找不到該病患的驗證資訊。");
        }
        const patientPassword = patientInfo[1];

        const payload = {
          event: this.events.DELETE_PATIENT,
          account: this.account,
          password: this.password,
          patient: patientAccount,
          patient_password: patientPassword,
        };
        const { message } = await this.postRequest(payload);

        if (message === this.events.messages.DELETE_PATIENT_SUCCESS) {
          console.log(`Patient ${patientAccount} deleted successfully.`);
          this.showAlert(
            `已成功刪除病患 ${patientAccount} 及其所有資料`,
            "success",
          );
          // Refresh lists thoroughly
          await this.syncMonitorData();
        } else {
          console.error(
            `Failed to delete patient ${patientAccount}: ${message}`,
          );
          this.showAlert(
            `刪除病患 ${patientAccount} 時失敗: ${message}`,
            "danger",
          );
        }
      } catch (error) {
        console.error(`Error deleting patient ${patientAccount}:`, error);
        this.showAlert(
          `刪除病患 ${patientAccount} 時發生錯誤: ${error.message}`,
          "danger",
        );
      }
    },

    async clearPatientData(patientAccount, needConfirm = true) {
      if (!patientAccount) return;

      if (needConfirm) {
        const confirmed = await this.showConfirm(
          `確定要清除 ${patientAccount} 的所有資料嗎?此操作無法還原。`,
        );
        if (!confirmed) return;
      }

      console.log(`Clearing data for patient ${patientAccount}...`);
      try {
        // Use the updateRecords function with the cleared data
        await this.updateRecords(patientAccount, this.keysToFilter); // Default data
        this.showAlert(`已成功清除 ${patientAccount} 的所有資料`, "success");
      } catch (error) {
        // Error handling is done within updateRecords, but catch here just in case.
        console.error(
          `Failed to clear patient data for ${patientAccount}:`,
          error,
        );
        // Alert might be redundant if updateRecords showed one already.
        // this.showAlert(`清除 ${patientAccount} 的資料時發生錯誤`, "danger");
      }
    },

    // --- Search & Filtering ---
    // Debounced method to filter patient list based on search query
    filterPatients: debounce(function () {
      const query = this.searchQuery.trim().toLowerCase();
      if (query === "") {
        this.filteredPatientAccounts = this.monitoredPatientAccounts;
      } else {
        this.filteredPatientAccounts = this.monitoredPatientAccounts.filter(
          (account) => account.toLowerCase().includes(query),
        );
      }
      // console.log("Filtered accounts:", this.filteredPatientAccounts);
    }, 200), // 200ms debounce delay

    // --- Record Editing & Management ---
    async toggleRecordEdit(target, patientAccount) {
      if (!target || !target.attributes || !target.attributes.id) return;
      const idParts = target.attributes.id.textContent.split("-");
      if (idParts.length !== 2) return;

      const [dateKey, recordIndexStr] = idParts;
      const recordIndex = parseInt(recordIndexStr);

      // Ensure data exists
      if (
        !this.patientRecords[patientAccount]?.[dateKey]?.data?.[recordIndex]
      ) {
        console.error(
          "Record data not found for editing:",
          patientAccount,
          dateKey,
          recordIndex,
        );
        return;
      }

      const record =
        this.patientRecords[patientAccount][dateKey].data[recordIndex];

      if (this.editingRecordIndex === -1) {
        // --- Start Editing ---
        // If another record is being edited, save it first (or discard changes?)
        // For simplicity, we'll just prevent starting a new edit if one is active.
        if (
          this.editingRecordPatientAccount &&
          this.editingRecordPatientAccount !== patientAccount
        ) {
          this.showAlert("請先儲存或取消目前正在編輯的其他紀錄。", "warning");
          return;
        }
        // If a restriction is being edited, prevent record editing
        if (this.isEditingRestriction) {
          this.showAlert("請先儲存或取消飲食限制的編輯。", "warning");
          return;
        }

        console.log(
          `Start editing record: ${patientAccount} - ${dateKey} - Index ${recordIndex}`,
        );

        this.editingRecordIndex = recordIndex;
        this.editingRecordPatientAccount = patientAccount;
        this.editingRecordDateKey = dateKey; // Store date key as well

        // Store original values before editing starts
        this.tempPatientRecord = {};
        this.dietaryItems.forEach((item) => {
          // Store the *current* value as the original value
          this.tempPatientRecord[item] =
            record[item] === "" ||
            record[item] === null ||
            isNaN(parseInt(record[item]))
              ? 0
              : parseInt(record[item]);
          // Ensure the record has a valid number for editing input binding
          record[item] = this.tempPatientRecord[item];
        });
      } else {
        // --- Finish Editing ---
        // Check if the finished edit matches the *active* edit state
        if (
          this.editingRecordPatientAccount !== patientAccount ||
          this.editingRecordDateKey !== dateKey ||
          this.editingRecordIndex !== recordIndex
        ) {
          console.warn(
            "Finished editing mismatch with current editing state. Ignoring.",
          );
          // This might happen with rapid clicks, better to ignore than corrupt data
          return;
        }

        console.log(
          `Finish editing record: ${patientAccount} - ${dateKey} - Index ${recordIndex}`,
        );

        // Validate inputs (ensure they are numbers >= 0)
        let validationPassed = true;
        this.dietaryItems.forEach((item) => {
          const value = record[item];
          if (
            value === "" ||
            value === null ||
            isNaN(parseInt(value)) ||
            parseInt(value) < 0
          ) {
            record[item] = 0; // Default to 0 if invalid
            console.warn(`Invalid input for ${item}, defaulting to 0.`);
          } else {
            record[item] = parseInt(value); // Ensure it's stored as a number
          }
          // Check against original value
          if (record[item] < 0) {
            // Should be caught above, but double check
            validationPassed = false;
          }
        });

        if (!validationPassed) {
          this.showAlert("輸入值必須為 0 或正整數。", "danger");
          // Consider revert to temp values or just keep the corrected '0'
          // Reverting:
          // this.dietaryItems.forEach(item => {
          //     record[item] = this.tempPatientRecord[item];
          // });
          return; // Prevent saving invalid state
        }

        // Calculate the difference and update sums BEFORE resetting edit state
        const dateRecord = this.patientRecords[patientAccount][dateKey];
        let dataChanged = false;
        this.dietaryItems.forEach((item) => {
          const newValue = record[item]; // Already parsed to int
          const oldValue = this.tempPatientRecord[item]; // Stored original value
          const diff = newValue - oldValue;
          if (diff !== 0) {
            dateRecord[`${item}Sum`] = (dateRecord[`${item}Sum`] || 0) + diff;
            dataChanged = true;
          }
        });

        // Reset editing state *before* potentially async operations
        const wasEditingPatient = this.editingRecordPatientAccount;
        this.editingRecordIndex = -1;
        this.editingRecordPatientAccount = "";
        this.editingRecordDateKey = "";
        this.tempPatientRecord = {};

        // If all values are zero after editing, ask to remove the record
        const allZero = this.dietaryItems.every((item) => record[item] === 0);

        if (allZero && dataChanged) {
          // Only remove if it wasn't zero initially and changed
          console.log("Record edited to all zeros, prompting for removal.");
          // Use the same target element for removeRecord
          // Need to set confirming flag here? removeRecord does it.
          await this.removeRecord(target, patientAccount);
        } else if (dataChanged) {
          // Update records on the server only if data actually changed
          console.log("Record data changed, updating server.");
          await this.updateRecords(wasEditingPatient);
        } else {
          console.log("Record data not changed, no server update needed.");
        }
      }
    },

    async removeRecord(target, patientAccount) {
      if (this.removingRecord || this.confirming) return; // Prevent concurrent removals

      if (!target || !target.attributes || !target.attributes.id) return;
      const idParts = target.attributes.id.textContent.split("-");
      if (idParts.length !== 2) return;

      const [dateKey, indexStr] = idParts;
      const index = parseInt(indexStr);

      if (!this.patientRecords[patientAccount]?.[dateKey]?.data?.[index]) {
        console.error(
          "Record not found for removal:",
          patientAccount,
          dateKey,
          index,
        );
        return;
      }

      const record = this.patientRecords[patientAccount][dateKey].data[index];
      const dateRecord = this.patientRecords[patientAccount][dateKey];

      // --- Confirmation ---
      this.confirming = true; // Prevent sync during confirmation
      const dietaryItemsLabel = {
        food: "進食",
        water: "喝水",
        urination: "排尿",
        defecation: "排便",
      };
      const confirmMessage = [
        "請確認是否移除這筆資料:",
        `床號: ${patientAccount}`,
        `日期: ${dateKey.replaceAll(/_/g, "/")}`, // Display format
        `時間: ${record.time}`,
        ...this.dietaryItems.map(
          (item) => `${dietaryItemsLabel[item]}: ${record[item] ?? 0}`,
        ),
      ].join("\n");

      const confirmed = await this.showConfirm(confirmMessage);
      this.confirming = false; // Allow sync again after modal closes

      if (!confirmed) {
        console.log("Record removal cancelled.");
        return;
      }

      // --- Removal Logic ---
      console.log(
        `Removing record: ${patientAccount} - ${dateKey} - Index ${index}`,
      );
      this.removingRecord = true; // Prevent other actions during API call

      try {
        // 1. Update local sums *before* removing the item
        dateRecord.count = Math.max(0, dateRecord.count - 1); // Ensure count doesn't go below 0
        this.dietaryItems.forEach((item) => {
          const value = record[item] ?? 0; // Use 0 if value is null/undefined
          dateRecord[`${item}Sum`] = Math.max(
            0,
            (dateRecord[`${item}Sum`] || 0) - value,
          ); // Ensure sums don't go below 0
        });

        // 2. Remove the item from the local data array
        dateRecord.data.splice(index, 1);

        // 3. Update the backend with the modified patient record
        await this.updateRecords(patientAccount); // Send the whole patient record again

        this.showAlert("紀錄已成功移除。", "success");
      } catch (error) {
        console.error("Error during record removal:", error);
        this.showAlert(`移除紀錄時發生錯誤: ${error.message}`, "danger");
        // Re-sync data to ensure consistency after error
        await this.syncMonitorData();
      } finally {
        this.removingRecord = false; // Allow actions again
      }
    },

    // --- Restriction Editing ---
    updateRestrictionText(patientAccount) {
      const record = this.patientRecords[patientAccount];
      if (!record) return;

      const limitAmountStr = String(record.limitAmount ?? "").trim();
      const foodChecked = record.foodCheckboxChecked ?? false;
      const waterChecked = record.waterCheckboxChecked ?? false;
      let text = "";

      if (
        !isNaN(parseInt(limitAmountStr)) &&
        limitAmountStr !== "" &&
        (foodChecked || waterChecked)
      ) {
        const limitAmount = parseInt(limitAmountStr);
        if (foodChecked && waterChecked) {
          text = `限制 食物+水 < ${limitAmount} g/ml`;
        } else if (foodChecked) {
          text = `限制 食物 < ${limitAmount} g/ml`;
        } else if (waterChecked) {
          text = `限制 水 < ${limitAmount} g/ml`;
        }
      }

      this.restrictionText[patientAccount] = text;
    },

    /** Handles input for restriction amount, ensuring it's a non-negative integer */
    handleRestrictionInput(event, patientAccount) {
      let value = event.target.value;
      // Allow empty string, or positive numbers (including decimals if needed)
      if (value === "" || (!isNaN(parseInt(value)) && parseInt(value) >= 0)) {
        this.patientRecords[patientAccount].limitAmount = value;
      } else {
        // If invalid input, consider revert to the previous valid value or show an error
        console.warn("Invalid restriction amount input:", value);
      }
    },

    /** Toggles the edit mode for intake restrictions */
    async toggleRestrictionEdit(patientAccount) {
      if (!this.patientRecords[patientAccount]) return;

      const record = this.patientRecords[patientAccount];
      const isCurrentlyEditingThis = record.isEditing;

      if (isCurrentlyEditingThis) {
        console.log(`Attempting to save restriction for ${patientAccount}`);
        const limitAmountStr = String(record.limitAmount ?? "").trim();
        const foodChecked = record.foodCheckboxChecked ?? false;
        const waterChecked = record.waterCheckboxChecked ?? false;
        let isValid = true;
        let errorMsg = "";

        // Validate: If any checkbox is checked, amount must be a valid non-negative integer.
        // If no checkbox is checked, amount should ideally be empty (or ignored).
        if (foodChecked || waterChecked) {
          if (
            limitAmountStr === "" ||
            isNaN(parseInt(limitAmountStr)) ||
            parseInt(limitAmountStr) < 0
          ) {
            isValid = false;
            errorMsg = "以勾選限制項目，請輸入有效的限制數值(大於等於0)。";
          } else {
            // Ensure stored value is numeric if valid
            record.limitAmount = parseInt(limitAmountStr);
          }
        } else {
          // No checkboxes checked, clear the amount for consistency?
          // record.limitAmount = "";
        }

        if (!isValid) {
          this.showAlert(errorMsg, "danger");
          return;
        }

        // --- Validation Passed ---
        record.isEditing = false; // Turn off editing mode locally first
        this.isEditingRestriction = false; // Turn off global flag
        this.currentEditingPatient = "";
        this.updateRestrictionText(patientAccount); // Update display text
        await this.updateRecords(patientAccount); // Save changes to backend
        console.log(`Restriction saved for ${patientAccount}`);
      } else {
        // --- Start Editing Restriction ---
        // If another restriction is being edited, save it first
        if (
          this.isEditingRestriction &&
          this.currentEditingPatient !== patientAccount
        ) {
          // Find the other patient's record and try to save it
          const otherPatientRecord =
            this.patientRecords[this.currentEditingPatient];
          if (otherPatientRecord && otherPatientRecord.isEditing) {
            // Attempt to save the other one silently or prompt?
            // Currently just revert the other one without saving
            console.warn(
              `Cancelling restriction edit for ${this.currentEditingPatient} to edit ${patientAccount}`,
            );
            otherPatientRecord.isEditing = false; // Revert state
            this.updateRestrictionText(this.currentEditingPatient); // Update its text
            // No API call needed as changes are discarded
          }
        }
        // If a record row is being edited, prevent restriction editing
        if (this.editingRecordIndex !== -1) {
          this.showAlert("請先儲存或取消目前正在編輯的紀錄。", "warning");
          return;
        }

        console.log(`Start editing restriction for ${patientAccount}`);
        record.isEditing = true;
        this.isEditingRestriction = true;
        this.currentEditingPatient = patientAccount;
        // No API call needed yet, just changing local state
      }
    },

    // --- Data Transfer ---
    openTransferModal(fromPatient) {
      this.transferFrom = fromPatient;
      this.transferTo = ""; // Reset target field
      const modalElement = document.getElementById("transferModal");
      if (modalElement) {
        const modal = bootstrap.Modal.getOrCreateInstance(modalElement);
        modal.show();
      } else {
        console.error("Transfer modal element not found.");
      }
    },

    async transferPatientData() {
      const fromPatient = this.transferFrom;
      const toPatient = this.transferTo.trim();

      // --- Validations ---
      if (!toPatient) {
        this.showAlert("請輸入目標帳號。", "danger");
        return;
      }
      if (fromPatient === toPatient) {
        this.showAlert("來源和目標帳號不能相同。", "danger");
        return;
      }

      const isTargetMonitored =
        this.monitoredPatientAccounts.includes(toPatient);
      const isTargetUnmonitored = this.unmonitoredPatients.includes(toPatient);

      if (!isTargetMonitored && !isTargetUnmonitored) {
        this.showAlert("目標帳號不存在。", "danger");
        return;
      }

      if (isTargetUnmonitored) {
        this.showAlert(
          "目標帳號尚未加入監測，請先將其加入監測列表後再進行轉移。",
          "warning",
        );
        return;
      }

      // Check if target patient *already has data* (excluding control keys)
      const targetData = this.patientRecords[toPatient];
      let targetHasExistingData = false;
      if (targetData) {
        targetHasExistingData = Object.keys(targetData).some(
          (key) => !this.keysToFilter.hasOwnProperty(key),
        );
      }

      if (targetHasExistingData) {
        this.showAlert(
          "目標帳號已有資料，無法轉移。請先清除目標帳號的資料",
          "danger",
        );
        return;
      }

      // --- Confirmation ---
      const confirmed = await this.showConfirm(
        `確定要將 ${fromPatient} 的資料轉移到 ${toPatient} 嗎?`,
      );
      if (!confirmed) return;

      // --- Transfer Process ---
      console.log(
        `Starting data transfer from ${fromPatient} to ${toPatient}...`,
      );
      try {
        const dataToTransfer = this.patientRecords[fromPatient];
        if (!dataToTransfer) {
          throw new Error(`找不到來源帳號 ${fromPatient} 的資料。`);
        }

        // 1. Update target patient's record on the backend
        await this.updateRecords(toPatient, dataToTransfer);
        console.log(`Data successfully written to ${toPatient}.`);

        // 2. Clear source patient's data on the backend (without confirmation)
        await this.clearPatientData(this.transferFrom, false);
        console.log(`Data cleared for ${fromPatient}.`);

        // 3. Hide modal and show success message
        const modalElement = document.getElementById("transferModal");
        if (modalElement) {
          const modal = bootstrap.Modal.getInstance(modalElement);
          if (modal) modal.hide();
        }
        this.showAlert(
          `資料已成功從 ${fromPatient} 轉移到 ${toPatient}`,
          "success",
        );

        // 4. Refresh data
        await this.syncMonitorData();
      } catch (error) {
        console.error("Data transfer failed:", error);
        this.showAlert(`資料轉移失敗: ${error.message}`, "danger");
        // TODO: Consider if partial transfer requires manual cleanup or retry
      }
    },

    // --- Sign Up ---
    async signUpPatient() {
      this.signUpPatientSubmitted = true; // Trigger validation feedback
      const form = document.getElementById("signUpForm"); // Give the form an id instead

      if (form && form.checkValidity()) {
        console.log("Signing up new patient:", this.signUpPatientAccount);
        try {
          const payload = {
            event: this.events.SIGN_UP_PATIENT,
            account: this.account, // Admin account
            password: this.password, // Admin password
            patient: this.signUpPatientAccount,
            patient_password: this.signUpPatientPassword,
          };
          const response = await this.postRequest(payload);

          if (response.message === this.events.messages.ACCT_CREATED) {
            // Check for specific success message
            this.signUpAlertMessage = `病患帳號 ${this.signUpPatientAccount} 註冊成功。`;
            this.signUpAlertClass = "alert-success";

            // Auto-add to monitor if checked
            if (this.autoAddToMonitor) {
              // Use await here to ensure it completes before potentially closing modal
              await this.addPatientToMonitor(this.signUpPatientAccount);
            } else {
              // Refresh unmonitored list if not auto-adding, as the new patient should appear there
              await this.fetchUnmonitoredPatients();
            }

            // Hide modal after delay unless 'stayOpen' is checked
            if (!this.stayOpenAfterSignup) {
              setTimeout(() => {
                const modalElement = document.getElementById("signUpModal");
                if (modalElement) {
                  const modal = bootstrap.Modal.getInstance(modalElement);
                  if (modal) modal.hide();
                  // Reset state after modal is hidden
                  this.resetSignUpForm();
                }
              }, 1500); // Shorter delay for success
            } else {
              // Reset form immediately if staying open
              this.resetSignUpForm(false); // Don't clear success message yet
              setTimeout(() => {
                this.signUpAlertMessage = "";
              }, 3000); // Clear message later
            }
          } else if (
            response.message === this.events.messages.ACCT_ALREADY_EXISTS
          ) {
            this.signUpAlertMessage = "此病患帳號名稱已被使用。";
            this.signUpAlertClass = "alert-danger";
            this.signUpPatientAccount = "";
            this.signUpPatientPassword = "";
          } else {
            // Handle other potential errors from API
            this.signUpAlertMessage = `註冊失敗: ${response.message || "未知錯誤"}`;
            this.signUpAlertClass = "alert-danger";
          }
        } catch (error) {
          console.error("Sign up failed:", error);
          this.signUpAlertMessage = `註冊時發生錯誤: ${error.message}`;
          this.signUpAlertClass = "alert-danger";
        }
      } else {
        // Form validation failed (HTML5)
        console.log("Sign up form invalid.");
        if (!form) console.error("Sign up form element not found.");
        // Generic message, but browser usually handles feedback
        this.signUpAlertMessage = "請填寫所有必填欄位。";
        this.signUpAlertClass = "alert-warning";
      }
    },

    resetSignUpForm(clearMessage = true) {
      this.signUpPatientAccount = "";
      this.signUpPatientPassword = "";
      this.signUpPatientSubmitted = false;
      // Don't clear success message yet
      if (clearMessage) {
        this.signUpAlertMessage = "";
      }
    },

    // --- QR Code ---
    openQrCodeModal(patientAccount) {
      const patientInfo = this.patientAccountsWithPasswords.find(
        (p) => p[0] === patientAccount,
      );

      if (!patientInfo) {
        this.showAlert(`找不到病患 ${patientAccount} 的登入資訊`, "danger");
        return;
      }

      const [patient, patient_password] = patientInfo;
      this.qrCodePatient = patient;
      this.qrCodePatientPassword = patient_password; // Store if needed elsewhere

      const encodedPatient = encodeURIComponent(patient);
      const encodedPassword = encodeURIComponent(patient_password);

      if (!this.webUrl) {
        this.showAlert("網頁 URL 未設定，無法生成 QR Code。", "danger");
        return;
      }

      // Construct URL for the patient view
      const qrData = `${this.webUrl}/patient/?acct=${encodedPatient}&pw=${encodedPassword}`;
      console.log("Generating QR Code for:", qrData);

      try {
        // Using the provided qrcode-generator library syntax
        const qr = qrcode(0, "H"); // Type 0, Error Correction Level H
        qr.addData(qrData);
        qr.make();

        const qrCodeContainer = document.getElementById("qrCodeContainer");
        if (!qrCodeContainer)
          throw new Error("QR Code container element not found.");
        qrCodeContainer.innerHTML = ""; // Clear previous QR code

        // Render to canvas
        const canvas = document.createElement("canvas");
        // Let the library decide initial size based on data, then scale if needed
        // qr.renderTo2dContext(canvas.getContext("2d"), moduleSize);
        // Or use the library's DOM element creation method if available
        // Example using createImgTag
        // qrCodeContainer.innerHTML = qr.createImgTag(6, 10); // (cellSize, margin)

        // Manual canvas rendering
        const scale = 6; // Size of each QR module in pixels
        const size = qr.getModuleCount() * scale;
        canvas.width = size;
        canvas.height = size;
        canvas.id = "qrCanvas"; // Assign ID for later use (copy/print)
        qr.renderTo2dContext(canvas.getContext("2d"), scale);
        qrCodeContainer.appendChild(canvas);

        // Show the Bootstrap modal
        const modalElement = document.getElementById("qrCodeModal");
        if (!modalElement) throw new Error("QR Code modal element not found.");
        const modal = bootstrap.Modal.getOrCreateInstance(modalElement);
        modal.show();
      } catch (error) {
        console.error("Failed to generate or display QR Code:", error);
        this.showAlert(`產生 QR Code 時發生錯誤: ${error.message}`, "danger");
      }
    },

    async copyQrCodeImage(event) {
      const canvas = document.getElementById("qrCanvas");
      const btn = event.currentTarget; // Use currentTarget for the button clicked
      const icon = btn ? btn.querySelector("i") : null;

      if (!canvas) {
        this.showAlert("找不到 QR Code 圖片。", "danger");
        return;
      }

      if (!navigator.clipboard || !navigator.clipboard.write) {
        this.showAlert(
          "您的瀏覽器不支援或未啟用剪貼簿複製圖片功能。",
          "warning",
        );
        return;
      }

      try {
        // Get blob from canvas
        const blob = await new Promise((resolve, reject) => {
          canvas.toBlob((blob) => {
            if (blob) {
              resolve(blob);
            } else {
              reject(new Error("Canvas toBlob failed."));
            }
          }, "image/png");
        });

        // Write to clipboard using Clipboard API
        await navigator.clipboard.write([
          new ClipboardItem({ [blob.type]: blob }),
        ]);

        // Visual feedback
        if (icon) {
          const originalClass = icon.className;
          icon.className = "fas fa-check text-success"; // Indicate success
          setTimeout(() => {
            if (icon) icon.className = originalClass; // Restore original icon
          }, 2000);
        } else {
          // Show alert when icon visual feedback is not working
          this.showAlert("QR Code 圖片已複製到剪貼簿。", "success", 2000); // Shorter success message
        }
      } catch (error) {
        console.error("Copy QR Code image failed:", error);
        this.showAlert(
          "複製 QR Code 失敗。請嘗試在圖片上按右鍵 -> 複製圖片。",
          "danger",
        );
      }
    },

    printQrCode() {
      const canvas = document.getElementById("qrCanvas");
      const patientName = this.qrCodePatient || "病患"; // Use stored name

      if (!canvas) {
        this.showAlert("找不到 QR Code 圖片。", "danger");
        return;
      }

      try {
        const dataUrl = canvas.toDataURL("image/png");
        const printWindow = window.open("", "_blank");

        if (!printWindow) {
          this.showAlert(
            "無法開啟列印視窗，請檢查您的彈出視窗攔截設定。",
            "warning",
          );
          return;
        }

        printWindow.document.write(`
            <html>
                <head>
                    <title>列印 QR Code - ${patientName}</title>
                    <style>
                        @media print {
                            body { margin: 0; } /* Remove default margins for printing */
                            #print-content { page-break-inside: avoid; } /* Try to keep content on one page */
                        }
                        body {
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            min-height: 90vh; /* Use min-height */
                            font-family: sans-serif;
                            text-align: center; /* Center align text */
                        }
                        #print-content {
                             padding: 20px;
                             display: inline-block; /* Fit content size */
                        }
                        h2 {
                            font-size: 18px;
                            margin-top: 0;
                            margin-bottom: 15px;
                        }
                        img {
                            max-width: 100%; /* Ensure image fits */
                            height: auto; /* Maintain aspect ratio */
                            display: block; /* Remove extra space below image */
                            margin: 0 auto; /* Center image */
                        }
                    </style>
                </head>
                <body>
                    <div id="print-content">
                        <h2>${patientName}</h2>
                        <img src="${dataUrl}" alt="QR Code for ${patientName}" onload="window.print(); setTimeout(window.close, 100);" />
                    </div>
                </body>
            </html>
        `);
        printWindow.document.close();
      } catch (error) {
        console.error("Failed to prepare QR Code for printing:", error);
        this.showAlert(
          `準備列印 QR Code 時發生錯誤: ${error.message}`,
          "danger",
        );
      }
    },

    // --- UI Helpers ---
    showAlert(message, type = "success", duration = 3000) {
      this.bootstrapAlertMessage = message;
      // Map simple type to Bootstrap class
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

      // Clear existing timeout if any
      if (this.alertTimeoutId) {
        clearTimeout(this.alertTimeoutId);
      }

      // Set new timeout to clear the message
      this.alertTimeoutId = setTimeout(() => {
        this.bootstrapAlertMessage = "";
        this.alertTimeoutId = null; // Clear the timeout id
      }, duration);
    },

    showConfirm(message) {
      this.confirmMessage = message;
      this.confirming = true; // Set flag while modal is potentially visible

      return new Promise((resolve) => {
        this.confirmResolver = resolve; // Store the resolver function

        const modalElement = document.getElementById("confirmModal");
        if (modalElement) {
          // Ensure previous instances are handled if necessary, or use getOrCreateInstance
          const modal = bootstrap.Modal.getOrCreateInstance(modalElement);

          // Add event listeners for modal close events to resolve promise as false
          const handleModalClose = () => {
            // console.log("Confirm modal hidden/closed.");
            if (this.confirmResolver) {
              this.confirmResolver(false); // Resolve false if closed without button click
              this.confirmResolver = null;
            }
            this.confirming = false; // Reset flag when modal is fully hidden
            // Clean up listeners
            modalElement.removeEventListener(
              "hidden.bs.modal",
              handleModalClose,
            );
          };
          // Use 'hidden.bs.modal' which fires after the modal is fully hidden
          modalElement.addEventListener("hidden.bs.modal", handleModalClose, {
            once: true,
          });

          modal.show();
        } else {
          console.error("Confirm modal element not found.");
          resolve(false); // Resolve false immediately if modal can't be shown
          this.confirming = false;
        }
      });
    },

    /** Handles the result from the confirmation modal buttons */
    handleConfirm(result) {
      // No need to manually hide the modal here if data-bs-dismiss="modal" is used on buttons.
      // The 'hidden.bs.modal' listener in showConfirm handles the closing case.
      if (this.confirmResolver) {
        this.confirmResolver(result); // Resolve the promise with the button result (true/false)
        this.confirmResolver = null; // Clear resolver
      } else {
        // This case might happen if the modal was closed forcefully before a button was clicked
        console.warn("Confirm button clicked, but no active resolver found.");
      }
      // The 'confirming' flag is reset by the 'hidden.bs.modal' listener.
    },

    /** Gets the first and last record dates for a patient */
    getFirstAndLastDates(patientAccount) {
      const record = this.patientRecords[patientAccount];
      if (!record) return "無紀錄";

      const dateKeys = Object.keys(record).filter(
        (key) =>
          !this.keysToFilter.hasOwnProperty(key) &&
          /^\d{4}_\d{1,2}_\d{1,2}$/.test(key), // Basic validation for date key format
      );

      if (dateKeys.length === 0) {
        return "無紀錄";
      }

      // Sort keys chronologically (important if keys aren't guaranteed ordered)
      dateKeys.sort((a, b) => {
        // Convert YYYY_M_D to comparable format (e.g., YYYYMMDD)
        const dateA = new Date(a.replace(/_/g, "-")); // Convert to YYYY-MM-DD for Date parsing
        const dateB = new Date(b.replace(/_/g, "-"));
        return dateA - dateB;
      });

      const firstDate = dateKeys[0].replace(/_/g, "/"); // Format for display
      const lastDate = dateKeys[dateKeys.length - 1].replace(/_/g, "/"); // Format for display

      return `${firstDate} ~ ${lastDate}`;
    },

    /** Determines the color for the food sum display based on restrictions */
    getFoodSumColor(patientAccount) {
      const record = this.patientRecords[patientAccount];
      const todayRecord = record?.[this.currentDateYY_MM_DD];

      // Ensure necessary data exists and restriction is active
      if (
        !record ||
        !todayRecord ||
        !record.foodCheckboxChecked ||
        !record.limitAmount ||
        isNaN(parseInt(record.limitAmount))
      ) {
        return "inherit"; // Default color if no valid restriction applies
      }

      const limit = parseInt(record.limitAmount);
      const foodSum = todayRecord.foodSum ?? 0;
      const waterSum = todayRecord.waterSum ?? 0;

      let totalIntake = foodSum;
      if (record.waterCheckboxChecked) {
        // If water is also checked, consider the combined sum
        totalIntake += waterSum;
      }
      return totalIntake >= limit ? "red" : "inherit";
    },

    /** Determines the color for the water sum display based on restrictions */
    getWaterSumColor(patientAccount) {
      const record = this.patientRecords[patientAccount];
      const todayRecord = record?.[this.currentDateYY_MM_DD];

      // Ensure necessary data exists and restriction is active
      if (
        !record ||
        !todayRecord ||
        !record.waterCheckboxChecked ||
        !record.limitAmount ||
        isNaN(parseInt(record.limitAmount))
      ) {
        return "inherit"; // Default color if no valid restriction applies
      }

      const limit = parseInt(record.limitAmount);
      const foodSum = todayRecord.foodSum ?? 0;
      const waterSum = todayRecord.waterSum ?? 0;

      let totalIntake = waterSum;
      if (record.foodCheckboxChecked) {
        // If food is also checked, consider the combined sum
        totalIntake += foodSum;
      }
      return totalIntake >= limit ? "red" : "inherit";
    },

    /** Scrolls the window to the top smoothly */
    scrollToTop() {
      globalThis.scrollTo({
        top: 0,
        behavior: "smooth",
      });
    },

    /** Handles the window scroll event to show/hide the scroll-to-top button */
    handleScroll() {
      // Show button when scrolled down more than a certain amount (e.g., 100px)
      this.showScrollButton = globalThis.scrollY > 100;
    },
  },
}).mount("#app");
