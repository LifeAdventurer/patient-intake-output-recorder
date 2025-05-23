from datetime import date, datetime, timedelta
from datetime import time as time_cls
from typing import Any

from constants import limits
from pydantic import (
    BaseModel,
    Field,
    NonNegativeInt,
    RootModel,
    model_validator,
)

BUFFER_DAYS = 1
BUFFER_MINUTES = 24 * 60  # 1 day buffer in minutes


def parse_date_key(key: str) -> date:
    try:
        y, m, d = map(int, key.split("_"))
        return date(y, m, d)
    except Exception as e:
        raise ValueError(f"Invalid date key: `{key}`") from e


def parse_record_date(value: str) -> date:
    try:
        m, d = map(int, value.split("/"))
        return date.today().replace(month=m, day=d)
    except Exception as e:
        raise ValueError(f"Invalid recordDate: `{value}`") from e


def parse_time(value: str) -> time_cls:
    try:
        return datetime.strptime(value, "%H:%M").time()
    except Exception as e:
        raise ValueError(f"Invalid time: `{value}`") from e


class RecordItem(BaseModel):
    time: str
    food: NonNegativeInt
    water: NonNegativeInt
    urination: NonNegativeInt
    defecation: NonNegativeInt


class DailyRecord(BaseModel):
    data: list[RecordItem]
    count: NonNegativeInt
    recordDate: str
    foodSum: NonNegativeInt
    waterSum: NonNegativeInt
    urinationSum: NonNegativeInt
    defecationSum: NonNegativeInt
    weight: float

    @model_validator(mode="after")
    def validate_all(self):
        if self.count != len(self.data):
            raise ValueError("count does not match data length")

        for field in ["food", "water", "urination", "defecation"]:
            expected = sum(getattr(item, field) for item in self.data)
            actual = getattr(self, f"{field}Sum")
            if actual != expected:
                raise ValueError(
                    f"{field}Sum expected {expected}, got {actual}"
                )

            max_limit = limits.get(f"{field}Sum")
            if actual > max_limit:
                raise ValueError(
                    f"{field}Sum {actual} exceeds max limit {max_limit}"
                )

        record_date = parse_record_date(self.recordDate)
        if record_date > date.today() + timedelta(days=BUFFER_DAYS):
            raise ValueError(
                f"recordDate is too far in the future: {self.recordDate}"
            )

        if self.weight != 0:
            if self.weight <= 0:
                raise ValueError("weight must be a positive floating number")

            max_weight = limits.get("weight")
            if self.weight > max_weight:
                raise ValueError(
                    f"weight {self.weight} exceeds max limit {max_weight}"
                )

        return self


class PatientData(BaseModel):
    isEditing: bool
    limitAmount: str | NonNegativeInt
    foodCheckboxChecked: bool
    waterCheckboxChecked: bool
    records: dict[str, DailyRecord] = Field(default_factory=dict)

    @model_validator(mode="before")
    @classmethod
    def split_records(cls, values: dict[str, Any]):
        values = values.copy()
        reserved = {
            "isEditing",
            "limitAmount",
            "foodCheckboxChecked",
            "waterCheckboxChecked",
        }
        records = {k: v for k, v in values.items() if k not in reserved}

        values["records"] = records
        for key in list(values):
            if key not in reserved and key != "records":
                values.pop(key)

        return values

    @model_validator(mode="after")
    def check_key_and_record_date(self):
        for key, record in self.records.items():
            key_date = parse_date_key(key)
            if key_date > date.today() + timedelta(days=BUFFER_DAYS):
                raise ValueError(f"record key {key} is too far in the future")
            record_date = parse_record_date(record.recordDate)
            if (
                key_date.month != record_date.month
                or key_date.day != record_date.day
            ):
                raise ValueError(
                    f"recordDate {record_date} should be equal to record key {key_date}"
                )

        if isinstance(self.limitAmount, str) and self.limitAmount != "":
            raise ValueError(
                "limitAmount should be a positive number or empty string"
            )

        return self


class UpdateDataModel(RootModel[PatientData]):
    pass
