import datetime
import os
import unittest
from unittest.mock import patch

import db
from constants import (
    ACCT_CHANGE_SUCCESS,
    ACCT_CREATED,
    ACCT_NOT_EXIST,
    ADD_PATIENT,
    ADD_PATIENT_SUCCESS,
    AUTH_SUCCESS,
    CHANGE_PASSWORD,
    CHANGE_USERNAME,
    DELETE_DAILY_RECORD,
    DELETE_MONITOR,
    DELETE_MONITOR_SUCCESS,
    DELETE_PATIENT,
    DELETE_PATIENT_SUCCESS,
    FETCH_MONITORING_PATIENTS,
    FETCH_MONITORING_PATIENTS_SUCCESS,
    FETCH_RECORD,
    FETCH_RECORD_SUCCESS,
    FETCH_UNMONITORED_PATIENTS,
    FETCH_UNMONITORED_PATIENTS_SUCCESS,
    INVALID_EVENT,
    NEW_DAILY_RECORD,
    RECORD_DATA_CREATE_SUCCESS,
    RECORD_DATA_DELETE_SUCCESS,
    RECORD_DATA_UPDATE_SUCCESS,
    REMOVE_PATIENT,
    REMOVE_PATIENT_SUCCESS,
    SET_LIMITS_SUCCESS,
    SIGN_UP_MONITOR,
    SIGN_UP_PATIENT,
    TRANSFER_PATIENT,
    TRANSFER_PATIENT_NOT_EMPTY,
    TRANSFER_PATIENT_SUCCESS,
    UPDATE_DAILY_RECORD,
    UPDATE_LIMIT,
    UPDATE_RECORD,
    UPDATE_RECORD_SUCCESS,
)
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

TEST_DB = "test_accounts.db"
TEST_DATA_JSON = "test_data.json"
TEST_ACCT_REL_JSON = "test_account_relations.json"
TEST_TOKEN = "testtoken123"


def make_today_key():
    today = datetime.date.today()
    return (
        f"{today.year}_{today.month}_{today.day}",
        f"{today.month}/{today.day}",
    )


def mocked_load_json_file(path):
    if path.endswith("config.json"):
        return {"token": TEST_TOKEN}
    elif path.endswith("data.json"):
        return mocked_load_json_file.data
    elif path.endswith("account_relations.json"):
        return mocked_load_json_file.acct_rel
    return {}


def mocked_write_json_file(path, data):
    if path.endswith("data.json"):
        mocked_load_json_file.data = data
    elif path.endswith("account_relations.json"):
        mocked_load_json_file.acct_rel = data


class TestAPIEndpoints(unittest.TestCase):
    def setUp(self):
        db.ACCOUNTS_DB = TEST_DB
        db.create_table()

        mocked_load_json_file.data = {}
        mocked_load_json_file.acct_rel = {"monitor_accounts": {}}

    def tearDown(self):
        if os.path.exists(TEST_DB):
            os.remove(TEST_DB)

    @patch("main.load_json_file", side_effect=mocked_load_json_file)
    @patch("main.write_json_file", side_effect=mocked_write_json_file)
    def test_full_flow_with_token(self, _, __):
        res = client.post(
            "/",
            json={
                "token": TEST_TOKEN,
                "event": SIGN_UP_MONITOR,
                "account": "monitor1",
                "password": "pass123",
            },
        )
        self.assertEqual(res.json()["message"], ACCT_CREATED)

        res = client.post(
            "/",
            json={
                "token": TEST_TOKEN,
                "event": CHANGE_PASSWORD,
                "account": "monitor1",
                "password": "pass123",
                "new_password": "newpass",
            },
        )
        self.assertEqual(res.json()["message"], ACCT_CHANGE_SUCCESS)
        self.assertEqual(db.authenticate("monitor1", "newpass"), AUTH_SUCCESS)

        res = client.post(
            "/",
            json={
                "token": TEST_TOKEN,
                "event": CHANGE_USERNAME,
                "account": "monitor1",
                "password": "newpass",
                "new_account": "monitor_renamed",
            },
        )
        self.assertEqual(res.json()["message"], ACCT_CHANGE_SUCCESS)

        self.assertEqual(
            db.authenticate("monitor_renamed", "newpass"), AUTH_SUCCESS
        )

        res = client.post(
            "/",
            json={
                "token": TEST_TOKEN,
                "event": SIGN_UP_MONITOR,
                "account": "monitor1",
                "password": "pass123",
            },
        )
        self.assertEqual(res.json()["message"], ACCT_CREATED)

        res = client.post(
            "/",
            json={
                "token": TEST_TOKEN,
                "event": SIGN_UP_PATIENT,
                "account": "monitor1",
                "password": "pass123",
                "patient": "patient1",
                "patient_password": "p123",
            },
        )
        self.assertEqual(res.json()["message"], ACCT_CREATED)

        res = client.post(
            "/",
            json={
                "token": TEST_TOKEN,
                "event": ADD_PATIENT,
                "account": "monitor1",
                "password": "pass123",
                "patient": "patient1",
            },
        )
        self.assertEqual(res.json()["message"], ADD_PATIENT_SUCCESS)

        res = client.post(
            "/",
            json={
                "token": TEST_TOKEN,
                "event": FETCH_MONITORING_PATIENTS,
                "account": "monitor1",
                "password": "pass123",
            },
        )
        self.assertEqual(
            res.json()["message"], FETCH_MONITORING_PATIENTS_SUCCESS
        )

        res = client.post(
            "/",
            json={
                "token": TEST_TOKEN,
                "event": REMOVE_PATIENT,
                "account": "monitor1",
                "password": "pass123",
                "patient": "patient1",
                "patient_password": "p123",
            },
        )
        self.assertEqual(res.json()["message"], REMOVE_PATIENT_SUCCESS)

        res = client.post(
            "/",
            json={
                "token": TEST_TOKEN,
                "event": FETCH_UNMONITORED_PATIENTS,
                "account": "monitor1",
                "password": "pass123",
            },
        )
        self.assertEqual(
            res.json()["message"], FETCH_UNMONITORED_PATIENTS_SUCCESS
        )
        self.assertEqual(len(res.json()["unmonitored_patients"]), 1)

        res = client.post(
            "/",
            json={
                "token": TEST_TOKEN,
                "event": DELETE_PATIENT,
                "account": "monitor1",
                "password": "pass123",
                "patient": "patient1",
                "patient_password": "p123",
            },
        )
        self.assertEqual(res.json()["message"], DELETE_PATIENT_SUCCESS)
        self.assertEqual(db.authenticate("patient1", "p123"), ACCT_NOT_EXIST)

        res = client.post(
            "/",
            json={
                "token": TEST_TOKEN,
                "event": DELETE_MONITOR,
                "account": "monitor1",
            },
        )
        self.assertEqual(res.json()["message"], DELETE_MONITOR_SUCCESS)
        self.assertEqual(db.authenticate("monitor1", "pass123"), ACCT_NOT_EXIST)

    @patch("main.load_json_file", side_effect=mocked_load_json_file)
    @patch("main.write_json_file", side_effect=mocked_write_json_file)
    def test_change_password_and_fetch_record_without_token(self, *_):
        db.add_account("patientX", "abc123", db.AccountType.PATIENT)

        res = client.post(
            "/",
            json={
                "event": CHANGE_PASSWORD,
                "account": "patientX",
                "password": "abc123",
                "new_password": "def456",
            },
        )
        self.assertEqual(res.json()["message"], ACCT_CHANGE_SUCCESS)
        self.assertEqual(db.authenticate("patientX", "def456"), AUTH_SUCCESS)

        res = client.post(
            "/",
            json={
                "event": CHANGE_USERNAME,
                "account": "patientX",
                "password": "def456",
                "new_account": "patientXX",
            },
        )
        self.assertEqual(res.json()["message"], ACCT_CHANGE_SUCCESS)
        self.assertEqual(db.authenticate("patientXX", "def456"), AUTH_SUCCESS)

        db.add_account("patientX", "def456", db.AccountType.PATIENT)

        today = datetime.date.today()
        key = f"{today.year}_{today.month}_{today.day}"
        display_date = f"{today.month}/{today.day}"
        now_time = datetime.datetime.now().strftime("%H:%M")
        valid_data = {
            "time": now_time,
            "food": 100,
            "water": 200,
            "urination": 1,
            "defecation": 0,
        }

        update_data = {
            "isEditing": False,
            "limitAmount": "",
            "foodCheckboxChecked": False,
            "waterCheckboxChecked": False,
            key: {
                "data": [valid_data],
                "count": 1,
                "recordDate": display_date,
                "foodSum": 100,
                "waterSum": 200,
                "urinationSum": 1,
                "defecationSum": 0,
                "weight": 53.12,
            },
        }

        mocked_load_json_file.data["patientX"] = {}

        res = client.post(
            "/",
            json={
                "event": UPDATE_RECORD,
                "account": "patientX",
                "password": "def456",
                "patient": "patientX",
                "data": update_data,
            },
        )
        self.assertEqual(res.json()["message"], UPDATE_RECORD_SUCCESS)

        future_key = f"{today.year + 1}_{today.month}_{today.day}"
        update_data[future_key] = update_data[key]
        res = client.post(
            "/",
            json={
                "event": UPDATE_RECORD,
                "account": "patientX",
                "password": "def456",
                "patient": "patientX",
                "data": update_data,
            },
        )
        self.assertIn("Invalid record format", res.json()["message"])
        update_data.pop(future_key)

        update_data[key]["recordDate"] = "1/1"
        res = client.post(
            "/",
            json={
                "event": UPDATE_RECORD,
                "account": "patientX",
                "password": "def456",
                "patient": "patientX",
                "data": update_data,
            },
        )
        self.assertIn("Invalid record format", res.json()["message"])
        update_data[key]["recordDate"] = display_date

        update_data[key]["recordDate"] = f"{today.month}/{today.day + 1}"
        res = client.post(
            "/",
            json={
                "event": UPDATE_RECORD,
                "account": "patientX",
                "password": "def456",
                "patient": "patientX",
                "data": update_data,
            },
        )
        self.assertIn("Invalid record format", res.json()["message"])
        update_data[key]["recordDate"] = display_date

        update_data[key]["foodSum"] = 99999
        res = client.post(
            "/",
            json={
                "event": UPDATE_RECORD,
                "account": "patientX",
                "password": "def456",
                "patient": "patientX",
                "data": update_data,
            },
        )
        self.assertIn("Invalid record format", res.json()["message"])
        update_data[key]["foodSum"] = 100

        update_data[key]["weight"] = 301
        res = client.post(
            "/",
            json={
                "event": UPDATE_RECORD,
                "account": "patientX",
                "password": "def456",
                "patient": "patientX",
                "data": update_data,
            },
        )
        self.assertIn("Invalid record format", res.json()["message"])

        update_data[key]["weight"] = -123
        res = client.post(
            "/",
            json={
                "event": UPDATE_RECORD,
                "account": "patientX",
                "password": "def456",
                "patient": "patientX",
                "data": update_data,
            },
        )
        self.assertIn("Invalid record format", res.json()["message"])

        update_data[key]["weight"] = "???"
        res = client.post(
            "/",
            json={
                "event": UPDATE_RECORD,
                "account": "patientX",
                "password": "def456",
                "patient": "patientX",
                "data": update_data,
            },
        )
        self.assertIn("Invalid record format", res.json()["message"])
        update_data[key]["weight"] = 53.12

        future_time = (
            datetime.datetime.now().replace(hour=23, minute=59)
        ).strftime("%H:%M")
        update_data[key]["data"][0]["time"] = future_time
        res = client.post(
            "/",
            json={
                "event": UPDATE_RECORD,
                "account": "patientX",
                "password": "def456",
                "patient": "patientX",
                "data": update_data,
            },
        )
        self.assertEqual(res.json()["message"], UPDATE_RECORD_SUCCESS)

        update_data[key]["data"][0]["time"] = now_time
        res = client.post(
            "/",
            json={
                "event": UPDATE_RECORD,
                "account": "patientX",
                "password": "def456",
                "patient": "patientX",
                "data": update_data,
            },
        )
        self.assertEqual(res.json()["message"], UPDATE_RECORD_SUCCESS)

        res = client.post(
            "/",
            json={
                "event": FETCH_RECORD,
                "account": "patientX",
                "password": "def456",
                "patient": "patientX",
            },
        )
        self.assertEqual(res.json()["message"], FETCH_RECORD_SUCCESS)
        self.assertEqual(res.json()["account_records"], update_data)

    @patch("main.load_json_file", side_effect=mocked_load_json_file)
    def test_invalid_token(self, _):
        res = client.post(
            "/",
            json={
                "token": "wrong_token",
                "event": SIGN_UP_MONITOR,
                "account": "user",
                "password": "pass",
            },
        )
        self.assertEqual(res.json()["message"], "Incorrect token")

    @patch("main.load_json_file", side_effect=mocked_load_json_file)
    def test_invalid_event_without_token(self, _):
        res = client.post("/", json={"event": "does_not_exist"})
        self.assertEqual(res.json()["message"], INVALID_EVENT)

    @patch("main.write_json_file", side_effect=mocked_write_json_file)
    @patch("main.load_json_file", side_effect=mocked_load_json_file)
    def test_record_crud(self, *_):
        db.add_account("patient1", "abc123", db.AccountType.PATIENT)
        db.add_account("monitor1", "monpass", db.AccountType.MONITOR)
        key, record_date = make_today_key()
        time = datetime.datetime.now().strftime("%H:%M")

        mocked_load_json_file.data = {}

        res = client.post(
            "/",
            json={
                "event": NEW_DAILY_RECORD,
                "account": "patient1",
                "password": "abc123",
                "patient": "patient1",
                "recordDate": record_date,
                "key": key,
                "time": time,
                "food": 100,
                "water": 200,
                "urination": 1,
                "defecation": 0,
                "weight": "NaN",
            },
        )

        self.assertEqual(res.json()["message"], RECORD_DATA_CREATE_SUCCESS)

        res = client.post(
            "/",
            json={
                "event": NEW_DAILY_RECORD,
                "account": "patient1",
                "password": "abc123",
                "patient": "patient1",
                "recordDate": record_date,
                "key": key,
                "time": time,
                "food": 100,
                "water": 200,
                "urination": 1,
                "defecation": 0,
                "weight": "54 kg",
            },
        )

        self.assertEqual(res.json()["message"], RECORD_DATA_CREATE_SUCCESS)

        res = client.post(
            "/",
            json={
                "event": NEW_DAILY_RECORD,
                "account": "patient1",
                "password": "abc123",
                "patient": "patient1",
                "recordDate": record_date,
                "key": key,
                "time": (
                    datetime.datetime.now() - datetime.timedelta(minutes=1)
                ).strftime("%H:%M"),
                "food": 100,
                "water": 200,
                "urination": 1,
                "defecation": 0,
                "weight": "54 kg",
            },
        )

        self.assertEqual(res.json()["message"], RECORD_DATA_CREATE_SUCCESS)

        mocked_load_json_file.data = {
            "patient1": {
                "isEditing": False,
                "limitAmount": "",
                "foodCheckboxChecked": False,
                "waterCheckboxChecked": False,
            }
        }

        res = client.post(
            "/",
            json={
                "event": UPDATE_LIMIT,
                "account": "monitor1",
                "password": "monpass",
                "patient": "patient1",
                "isEditing": True,
                "limitAmount": 1000,
                "foodCheckboxChecked": True,
                "waterCheckboxChecked": False,
            },
        )

        self.assertEqual(res.json()["message"], SET_LIMITS_SUCCESS)

        key, record_date = make_today_key()

        mocked_load_json_file.data = {
            "patient1": {
                key: {
                    "data": [
                        {
                            "time": time,
                            "food": 100,
                            "water": 100,
                            "urination": 1,
                            "defecation": 0,
                        }
                    ],
                    "count": 1,
                    "recordDate": record_date,
                    "foodSum": 100,
                    "waterSum": 100,
                    "urinationSum": 1,
                    "defecationSum": 0,
                    "weight": "NaN",
                },
                "isEditing": False,
                "limitAmount": "",
                "foodCheckboxChecked": False,
                "waterCheckboxChecked": False,
            }
        }

        res = client.post(
            "/",
            json={
                "event": UPDATE_DAILY_RECORD,
                "account": "patient1",
                "password": "abc123",
                "patient": "patient1",
                "time": time,
                "food": 200,
                "water": 100,
                "urination": 1,
                "defecation": 0,
                "weight": "55.2 kg",
                "key": key,
            },
        )

        self.assertEqual(res.json()["message"], RECORD_DATA_UPDATE_SUCCESS)

        key, record_date = make_today_key()

        mocked_load_json_file.data = {
            "patient1": {
                key: {
                    "data": [
                        {
                            "time": time,
                            "food": 100,
                            "water": 200,
                            "urination": 1,
                            "defecation": 0,
                        }
                    ],
                    "count": 1,
                    "recordDate": record_date,
                    "foodSum": 100,
                    "waterSum": 200,
                    "urinationSum": 1,
                    "defecationSum": 0,
                    "weight": "NaN",
                },
                "isEditing": False,
                "limitAmount": "",
                "foodCheckboxChecked": False,
                "waterCheckboxChecked": False,
            }
        }

        res = client.post(
            "/",
            json={
                "event": DELETE_DAILY_RECORD,
                "account": "patient1",
                "password": "abc123",
                "patient": "patient1",
                "key": key,
                "time": time,
            },
        )
        self.assertEqual(res.json()["message"], RECORD_DATA_DELETE_SUCCESS)

        db.add_account("patient2", "abc123", db.AccountType.PATIENT)
        mocked_load_json_file.data = {
            "patient1": {
                key: {
                    "data": [
                        {
                            "time": time,
                            "food": 100,
                            "water": 200,
                            "urination": 1,
                            "defecation": 0,
                        }
                    ],
                    "count": 1,
                    "recordDate": record_date,
                    "foodSum": 100,
                    "waterSum": 200,
                    "urinationSum": 1,
                    "defecationSum": 0,
                    "weight": "NaN",
                },
                "isEditing": False,
                "limitAmount": "",
                "foodCheckboxChecked": False,
                "waterCheckboxChecked": False,
            },
            "patient2": {
                "isEditing": False,
                "limitAmount": "",
                "foodCheckboxChecked": False,
                "waterCheckboxChecked": False,
            },
        }

        res = client.post(
            "/",
            json={
                "event": TRANSFER_PATIENT,
                "account": "monitor1",
                "password": "monpass",
                "patient_from": "patient1",
                "patient_to": "patient2",
            },
        )
        self.assertEqual(res.json()["message"], TRANSFER_PATIENT_SUCCESS)

        mocked_load_json_file.data = {
            "patient1": {
                key: {
                    "data": [
                        {
                            "time": time,
                            "food": 100,
                            "water": 200,
                            "urination": 1,
                            "defecation": 0,
                        }
                    ],
                    "count": 1,
                    "recordDate": record_date,
                    "foodSum": 100,
                    "waterSum": 200,
                    "urinationSum": 1,
                    "defecationSum": 0,
                    "weight": "NaN",
                },
                "isEditing": False,
                "limitAmount": "",
                "foodCheckboxChecked": False,
                "waterCheckboxChecked": False,
            },
            "patient2": {
                "isEditing": False,
                "limitAmount": "",
                "foodCheckboxChecked": False,
                "waterCheckboxChecked": False,
            },
        }

        res = client.post(
            "/",
            json={
                "event": TRANSFER_PATIENT,
                "account": "monitor1",
                "password": "monpass",
                "patient_from": "patient2",
                "patient_to": "patient1",
            },
        )
        self.assertEqual(res.json()["message"], TRANSFER_PATIENT_NOT_EMPTY)


if __name__ == "__main__":
    unittest.main()
