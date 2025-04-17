from datetime import date, datetime
from datetime import time as time_cls
from typing import Any

from constants import limits
from pydantic import (
    BaseModel,
    Field,
    NonNegativeInt,
    PositiveInt,
    RootModel,
    model_validator,
)


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
    weight: str

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
        if record_date > date.today():
            raise ValueError(f"recordDate is in the future: {self.recordDate}")

        if self.weight != "NaN":
            w = self.weight.split(" ")
            if len(w) != 2:
                raise ValueError(f"Invalid weight format: `{self.weight}`")
            weight_val, kg = w

            if kg != "kg":
                raise ValueError(f"Expected 'kg' unit, got '{kg}'")

            weight_val = float(weight_val)
            if weight_val <= 0:
                raise ValueError("weight must be a positive floating number")

            max_weight = limits.get("weight")
            if weight_val > max_weight:
                raise ValueError(
                    f"weight {weight_val} exceeds max limit {max_weight}"
                )

        for record in self.data:
            if record_date < date.today():
                continue
            input_time = parse_time(record.time)
            now = datetime.now().time()
            if input_time > now:
                raise ValueError(f"time {input_time} is in the future")

        return self


class PatientData(BaseModel):
    isEditing: bool
    limitAmount: str | PositiveInt
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
            if key_date > date.today():
                raise ValueError(f"record key {key} is in the future")
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


class UpdateDataModel(RootModel[PatientData]):
    pass
