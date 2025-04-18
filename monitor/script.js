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
      currentDateMMDD: "",
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
        this.showAlert("無法載入應用程式設定，請稍後再試。", "alert-danger");
        // Potentially halt application Initialization here if config is critical
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
        this.showAlert("無法載入 API 事件設定，請稍後再試。", "alert-danger");
        // Potentially halt application Initialization here if events are critical
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
        this.showAlert("請輸入帳號和密碼。", "alert-danger");
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
              this.showAlert("帳號不存在", "alert-danger");
              this.resetCredentials();
              break;
            case this.events.messages.AUTH_FAIL_PASSWORD:
              this.showAlert("密碼錯誤", "alert-danger");
              this.password = ""; // Clear only password
              break;
            case this.events.messages.INVALID_ACCT_TYPE:
              this.showAlert("此帳號沒有管理權限", "alert-danger");
              this.resetCredentials();
              break;
            default:
              // Handle other potential non-success messages
              this.showAlert(
                `驗證失敗: ${fetchedData.message}`,
                "alert-danger",
              );
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
        this.showAlert(`登入時發生錯誤: ${error.message}`, "alert-danger");
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

    processFetchedData(fetchedData) {
      this.patientRecords = fetchedData["patient_records"];
      this.patientAccountsWithPasswords = fetchedData["patient_accounts"];
      // NOTE: monitoredPatientAccounts computed property will update automatically

      this.monitoredPatientAccounts.forEach((patientAccount) => {
        let modified = false;
        Object.entries(this.keysToFilter).forEach(([key, value]) => {
          if (!(key in this.patientRecords[patientAccount])) {
            this.patientRecords[patientAccount][key] = value;
            modified = true;
          }
        });
        if (modified) {
          this.updateRecords(patientAccount);
        }
        this.updateRestrictionText(patientAccount);
      });
    },

    async syncMonitorData() {
      if (!this.authenticated) return;
      if (
        !this.isEditingRestriction &&
        this.editingRecordIndex === -1 &&
        !this.confirming
      ) {
        const fetchedData = await this.postRequest({
          event: this.events.FETCH_MONITORING_PATIENTS,
          account: this.account,
          password: this.password,
        });
        if (
          !this.confirming &&
          Object.hasOwn(fetchedData, "message") &&
          fetchedData.message ===
            this.events.messages.FETCH_MONITORING_PATIENTS_SUCCESS
        ) {
          this.processFetchedData(fetchedData);
          // No need to call filterPatients here, watcher will handle it if monitoredPatientAccounts changes
        }
      }
      await this.fetchUnmonitoredPatients();
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

    async updateRecords(
      patientAccount,
      record = this.patientRecords[patientAccount],
    ) {
      const payload = {
        event: this.events.UPDATE_RECORD,
        account: this.account,
        password: this.password,
        patient: patientAccount,
        data: record,
      };
      const { message } = await this.postRequest(payload);
      if (message === this.events.messages.UPDATE_RECORD_SUCCESS) {
        // TODO: Remove this console.log
        console.log(message);
      } else {
        console.error("Error:", message);
      }
    },

    async fetchUnmonitoredPatients() {
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
        this.unmonitoredPatients = response["unmonitored_patients"].map(
          (patient) => patient[1],
        );
      } else {
        console.error(response.message);
      }
    },
    async addPatientToMonitor(patient) {
      const payload = {
        event: this.events.ADD_PATIENT,
        account: this.account,
        password: this.password,
        patient: patient,
      };
      const { message } = await this.postRequest(payload);
      if (message === this.events.messages.ADD_PATIENT_SUCCESS) {
        // TODO: Remove this console.log
        console.log(message);
        await this.fetchUnmonitoredPatients();
      } else {
        console.error(message);
      }
    },
    openTransferModal(fromPatient) {
      this.transferFrom = fromPatient;
      this.transferTo = "";
      const transferModal = document.getElementById("transferModal");
      const modal = new bootstrap.Modal(transferModal);
      modal.show();
    },
    async transferPatientData() {
      if (!this.transferTo.trim()) {
        this.showAlert("請輸入目標帳號", "alert-danger");
        return;
      }

      const isTargetMonitored = this.monitoredPatientAccounts.includes(
        this.transferTo,
      );
      const isTargetUnmonitored = this.unmonitoredPatients.includes(
        this.transferTo,
      );

      if (!isTargetMonitored && !isTargetUnmonitored) {
        this.showAlert("欲轉移目標帳號不存在", "alert-danger");
        return;
      }

      if (isTargetUnmonitored) {
        this.showAlert(
          "目標帳號尚未加入監測，請先加入監測後再移轉資料",
          "alert-danger",
        );
        return;
      }

      const targetData = this.patientRecords[this.transferTo];
      const keys = Object.keys(targetData || {});
      const defaultKeys = [
        "isEditing",
        "limitAmount",
        "foodCheckboxChecked",
        "waterCheckboxChecked",
      ];
      const isOnlyDefaultKeys =
        keys.length === defaultKeys.length &&
        keys.every((k) => defaultKeys.includes(k));

      if (targetData && !isOnlyDefaultKeys) {
        this.showAlert(
          "目標帳號已有資料，無法轉移，請先清除資料",
          "alert-danger",
        );
        return;
      }

      const confirmed = await this.showConfirm(
        `確定要將 ${this.transferFrom} 的資料轉移到 ${this.transferTo} 嗎?`,
      );
      if (!confirmed) return;

      // Transfer
      await this.updateRecords(
        this.transferTo,
        this.patientRecords[this.transferFrom],
      );

      // Clear
      await this.clearPatientData(this.transferFrom, false);

      this.showAlert(
        `資料已成功從 ${this.transferFrom} 轉移到 ${this.transferTo}`,
      );
      bootstrap.Modal.getInstance(
        document.getElementById("transferModal"),
      ).hide();
      await this.syncMonitorData();
    },
    async clearPatientData(patient, needConfirm = true) {
      if (needConfirm) {
        const confirmed = await this.showConfirm(
          `確定要清除 ${patient} 的所有資料嗎?此操作無法還原。`,
        );
        if (!confirmed) {
          return;
        }
      }

      try {
        await this.updateRecords(patient, this.keysToFilter);
        this.showAlert(`已成功清除 ${patient} 的所有資料`);
      } catch (error) {
        console.error("Failed to clear patient data:", error);
        this.showAlert(`清除 ${patient} 的資料時發生錯誤`, "alert-danger");
      }
    },
    async removePatientFromMonitor(patient) {
      const [_, patient_password] = this.patientAccountsWithPasswords.find(
        (p) => p[0] === patient,
      );

      const payload = {
        event: this.events.REMOVE_PATIENT,
        account: this.account,
        password: this.password,
        patient,
        patient_password: patient_password,
      };

      const { message } = await this.postRequest(payload);

      if (message === this.events.messages.REMOVE_PATIENT_SUCCESS) {
        // TODO: Remove this console.log
        console.log(message);

        await this.syncMonitorData();
      } else {
        console.error(message);
      }
    },
    async deletePatient(patient) {
      const confirmed = await this.showConfirm(
        `請確認病患: ${patient} 是否要出院?`,
      );
      if (!confirmed) {
        return;
      }

      const [_, patient_password] = this.patientAccountsWithPasswords.find(
        (p) => p[0] === patient,
      );

      const payload = {
        event: this.events.DELETE_PATIENT,
        account: this.account,
        password: this.password,
        patient,
        patient_password: patient_password,
      };

      const { message } = await this.postRequest(payload);

      if (message === this.events.messages.DELETE_PATIENT_SUCCESS) {
        // TODO: Remove this console.log
        console.log(message);

        // Refresh lists thoroughly
        await this.syncMonitorData();
      } else {
        console.error(message);
      }
    },
    async signUpPatient() {
      this.signUpPatientSubmitted = true;

      const form = document.getElementById("signUpModal").querySelector("form");

      if (form.checkValidity()) {
        const payload = {
          event: this.events.SIGN_UP_PATIENT,
          account: this.account,
          password: this.password,
          patient: this.signUpPatientAccount,
          patient_password: this.signUpPatientPassword,
        };
        const response = await this.postRequest(payload);

        if (response.message === this.events.messages.ACCT_ALREADY_EXISTS) {
          this.signUpAlertMessage = "此帳號名已被使用。";
          this.signUpAlertClass = "alert-danger";
          this.signUpPatientAccount = "";
          this.signUpPatientPassword = "";
        } else {
          this.signUpAlertMessage = "註冊成功。";
          this.signUpAlertClass = "alert-success";

          setTimeout(async () => {
            if (!this.stayOpenAfterSignup) {
              const signUpModal = document.getElementById("signUpModal");
              const modalInstance = bootstrap.Modal.getInstance(signUpModal);
              modalInstance.hide();
            }
            if (this.autoAddToMonitor) {
              await this.addPatientToMonitor(this.signUpPatientAccount);
            }
            // Reset form and state
            this.signUpPatientAccount = "";
            this.signUpPatientPassword = "";
            this.signUpPatientSubmitted = false;
            this.signUpAlertMessage = "";
          }, 3000);
        }
      }
    },

    // --- Search & Filtering ---
    // Debounced method to filter patient list based on searchQuery
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

    openQrCodeModal(index) {
      const account = this.filteredPatientAccounts[index];
      const [patient, patient_password] =
        this.patientAccountsWithPasswords.find((p) => p[0] === account);
      this.qrCodePatient = patient;
      this.qrCodePatientPassword = patient_password;

      const encodedPatient = encodeURIComponent(patient);
      const encodedPassword = encodeURIComponent(patient_password);

      const qrData = `${this.webUrl}/patient/?acct=${encodedPatient}&pw=${encodedPassword}`;
      const qrCode = qrcode(0, "H");
      qrCode.addData(qrData);
      qrCode.make();

      const qrCodeContainer = document.getElementById("qrCodeContainer");
      // Clear previous content
      qrCodeContainer.innerHTML = "";

      const canvas = document.createElement("canvas");
      canvas.id = "qrCanvas";
      const desiredSize = 256;
      canvas.width = desiredSize;
      canvas.height = desiredSize;

      qrCode.renderTo2dContext(canvas.getContext("2d"), 6);
      qrCodeContainer.appendChild(canvas);

      const qrCodeModal = document.getElementById("qrCodeModal");
      const modalInstance = new bootstrap.Modal(qrCodeModal);
      modalInstance.show();
    },
    async copyQrCodeImage(event) {
      const canvas = document.getElementById("qrCanvas");
      const btn = event.target.closest("button");
      const icon = btn.querySelector("i");

      if (!canvas) {
        this.showAlert("找不到 QR Code 圖片。", "alert-danger");
        return;
      }

      try {
        const blob = await new Promise((resolve, reject) => {
          canvas.toBlob((blob) => {
            if (!blob) {
              reject(new Error("Failed to convert QR Code to image."));
            } else {
              resolve(blob);
            }
          }, "image/png");
        });

        await navigator.clipboard.write([
          new ClipboardItem({ [blob.type]: blob }),
        ]);

        icon.className = "fas fa-check";
        setTimeout(() => {
          icon.className = "fas fa-copy";
        }, 1500);
      } catch (error) {
        console.error("Copy QR Code failed:", error);
        this.showAlert(
          "複製 QR Code 失敗，請直接在上方的 QR Code 上按右鍵複製。",
          "alert-danger",
        );
      }
    },
    printQrCode() {
      const canvas = document.getElementById("qrCanvas");

      if (!canvas) {
        this.showAlert("找不到 QR Code 圖片。", "alert-danger");
        return;
      }

      const dataUrl = canvas.toDataURL("image/png");
      const patient = this.qrCodePatient;

      const printWindow = window.open("", "_blank");
      printWindow.document.write(`
        <html>
          <head>
            <title>列印 QR Code</title>
            <style>
              body {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                height: 100vh;
                margin: 0;
                font-family: sans-serif;
              }
              h2 {
                font-size: 18px;
                margin-bottom: 20px;
              }
              img {
                max-width: 90%;
                max-height: 90%;
              }
            </style>
          </head>
          <body>
            <h2>${patient}</h2>
            <img src="${dataUrl}" alt="QR Code" onload="window.print();" />
          </body>
        </html>
      `);
      printWindow.document.close();
    },
    updateRestrictionText(patientAccount) {
      const limitAmount = String(
        this.patientRecords[patientAccount]["limitAmount"],
      ).trim();
      if (!isNaN(limitAmount) && limitAmount !== "") {
        let text;
        if (
          this.patientRecords[patientAccount]["foodCheckboxChecked"] &&
          this.patientRecords[patientAccount]["waterCheckboxChecked"]
        ) {
          text = `限制進食加喝水不超過${
            this.patientRecords[patientAccount]["limitAmount"]
          }公克`;
        } else if (this.patientRecords[patientAccount]["foodCheckboxChecked"]) {
          text = `限制進食不超過${
            this.patientRecords[patientAccount]["limitAmount"]
          }公克`;
        } else if (
          this.patientRecords[patientAccount]["waterCheckboxChecked"]
        ) {
          text = `限制喝水不超過${
            this.patientRecords[patientAccount]["limitAmount"]
          }公克`;
        }
        this.restrictionText[patientAccount] = text;
      } else {
        this.restrictionText[patientAccount] = "";
      }
    },
    toggleRestrictionEdit(patientAccount) {
      const limitAmount = String(
        this.patientRecords[patientAccount]["limitAmount"],
      ).trim();
      if (this.patientRecords[patientAccount]["isEditing"]) {
        if (
          !this.patientRecords[patientAccount]["foodCheckboxChecked"] &&
          !this.patientRecords[patientAccount]["waterCheckboxChecked"]
        ) {
          if (isNaN(limitAmount)) {
            this.showAlert("請勾選選項並輸入數字", "alert-danger");
            return;
          } else if (limitAmount !== "") {
            this.showAlert("請勾選選項", "alert-danger");
            return;
          }
        } else if (isNaN(limitAmount) || limitAmount === "") {
          this.showAlert("請輸入數字", "alert-danger");
          return;
        } else if (limitAmount.startsWith("-") || limitAmount.startsWith(".")) {
          this.showAlert("請輸入正整數", "alert-danger");
          return;
        }
      }
      this.patientRecords[patientAccount]["isEditing"] =
        !this.patientRecords[patientAccount]["isEditing"];
      if (!this.patientRecords[patientAccount]["isEditing"]) {
        if (limitAmount !== "") {
          this.updateRestrictionText(patientAccount);
          this.currentEditingPatient = "";
        }
        this.updateRecords(patientAccount);
        this.isEditingRestriction = false;
      } else {
        this.isEditingRestriction = true;
        if (
          this.currentEditingPatient !== "" &&
          patientAccount !== this.currentEditingPatient
        ) {
          this.patientRecords[this.currentEditingPatient]["isEditing"] = false;
          this.updateRestrictionText(this.currentEditingPatient);
          this.updateRecords(this.currentEditingPatient);
        }
        this.currentEditingPatient = patientAccount;
      }
    },
    async toggleRecordEdit(target, patientAccount) {
      const [date, recordIndex] = target.attributes.id.textContent.split("-");
      const record =
        this.patientRecords[patientAccount][date]["data"][recordIndex];
      if (this.editingRecordIndex === -1) {
        this.editingRecordIndex = parseInt(recordIndex);
        this.editingRecordPatientAccount = patientAccount;
        for (const dietaryItem of this.dietaryItems) {
          this.tempPatientRecord[dietaryItem] = record[dietaryItem];
        }
      } else {
        this.editingRecordIndex = -1;
        this.editingRecordPatientAccount = "";
        for (const dietaryItem of this.dietaryItems) {
          if (record[dietaryItem] === "") {
            record[dietaryItem] = 0;
          }
          this.patientRecords[patientAccount][date][`${dietaryItem}Sum`] +=
            record[dietaryItem] - this.tempPatientRecord[dietaryItem];
        }
        await this.updateRecords(patientAccount);
        if (
          this.dietaryItems.every((dietaryItem) => record[dietaryItem] === 0)
        ) {
          await this.removeRecord(target, patientAccount);
        }
      }
    },
    handleInput(value, patientAccount) {
      const intValue = parseInt(value);
      if (!isNaN(intValue)) {
        this.patientRecords[patientAccount]["limitAmount"] = intValue;
      }
    },
    async removeRecord(target, patientAccount) {
      this.confirming = true;
      const [date, index] = target.attributes.id.textContent.split("-");
      const record = this.patientRecords[patientAccount][date]["data"][index];
      const confirmMessageLines = [
        "請確認是否移除這筆資料:",
        `床號: ${patientAccount}`,
        `日期: ${date.replaceAll("_", "/")}`,
        `時間: ${record["time"]}`,
        `進食: ${record["food"]}`,
        `喝水: ${record["water"]}`,
        `排尿: ${record["urination"]}`,
        `排便: ${record["defecation"]}`,
      ];
      const confirmMessage = confirmMessageLines.join("\n");
      const confirmed = await this.showConfirm(confirmMessage);
      if (confirmed) {
        this.removingRecord = true;

        this.patientRecords[patientAccount][date]["count"] -= 1;
        for (const dietaryItem of this.dietaryItems) {
          this.patientRecords[patientAccount][date][`${dietaryItem}Sum`] -=
            record[dietaryItem];
        }
        this.patientRecords[patientAccount][date]["data"].splice(index, 1);

        await this.updateRecords(patientAccount);
        this.removingRecord = false;
      }
      this.confirming = false;
    },

    showAlert(message, type = "success") {
      this.bootstrapAlertMessage = message;
      this.bootstrapAlertClass =
        type === "success" ? "alert-success" : "alert-danger";

      setTimeout(() => {
        this.bootstrapAlertMessage = "";
      }, 3000);
    },

    showConfirm(message) {
      this.confirmMessage = message;

      return new Promise((resolve) => {
        this.confirmResolver = resolve;

        const confirmModal = document.getElementById("confirmModal");
        const modal = new bootstrap.Modal(confirmModal);
        modal.show();
      });
    },

    handleConfirm(result) {
      const confirmModal = document.getElementById("confirmModal");
      const modal = bootstrap.Modal.getInstance(confirmModal);
      modal.hide();

      if (this.confirmResolver) {
        this.confirmResolver(result);
        this.confirmResolver = null;
      }
    },

    getFirstAndLastDates(patientAccount) {
      const keys = Object.keys(this.patientRecords[patientAccount]).filter(
        (key) => {
          return !(key in this.keysToFilter);
        },
      );
      if (keys.length === 0) {
        return "無紀錄";
      }
      const firstDate = keys[0].replace(/_/g, "/");
      const lastDate = keys[keys.length - 1].replace(/_/g, "/");
      return `${firstDate} ~ ${lastDate}`;
    },

    getFoodSumColor(patientAccount) {
      let exceed = false;
      const patientRecord = this.patientRecords[patientAccount];
      if (patientRecord["foodCheckboxChecked"]) {
        exceed =
          patientRecord[this.currentDateYY_MM_DD]["foodSum"] +
            (patientRecord["waterCheckboxChecked"]
              ? patientRecord[this.currentDateYY_MM_DD]["waterSum"]
              : 0) >
          patientRecord["limitAmount"];
      }
      return exceed ? "red" : "inherit";
    },

    getWaterSumColor(patientAccount) {
      let exceed = false;
      const patientRecord = this.patientRecords[patientAccount];
      if (patientRecord["waterCheckboxChecked"]) {
        exceed =
          patientRecord[this.currentDateYY_MM_DD]["waterSum"] +
            (patientRecord["foodCheckboxChecked"]
              ? patientRecord[this.currentDateYY_MM_DD]["foodSum"]
              : 0) >
          patientRecord["limitAmount"];
      }
      return exceed ? "red" : "inherit";
    },

    scrollToTop() {
      globalThis.scrollTo({
        top: 0,
        behavior: "smooth",
      });
    },

    handleScroll() {
      this.showScrollButton = globalThis.scrollY > 20;
    },
  },
}).mount("#app");
