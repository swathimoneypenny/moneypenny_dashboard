import pandas as pd
import os
from dotenv import load_dotenv

load_dotenv()

SHEET_ID = os.getenv("SHEET_ID", "1aRDAD4rn6_Aezvf3MNNLTtE6di17Zd5JtUnHvGzMaaY")


def get_eod_data():
    try:
        # EOD Sheet
        url_eod = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:csv&sheet=ABS"
        df_eod = pd.read_csv(url_eod)

        # Delay Questions Sheet
        url_delay = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:csv&sheet=ABS%20-%20Delay%20qsn"
        df_delay = pd.read_csv(url_delay)

        eod_text = format_eod(df_eod)
        delay_text = format_delay(df_delay)

        return eod_text + "\n\n" + delay_text

    except Exception as e:
        return f"EOD Sheet error: {str(e)}"


def format_eod(df):
    try:
        lines = ["=== ABS EOD SHEET (Latest 10 days) ==="]
        df_clean = df.dropna(how="all").tail(10)

        for _, row in df_clean.iterrows():
            date = str(row.iloc[0])[:10] if pd.notna(row.iloc[0]) else "N/A"
            committed = row.iloc[1] if pd.notna(row.iloc[1]) else 0
            booked = row.iloc[2] if pd.notna(row.iloc[2]) else 0
            bod = str(row.iloc[10]) if pd.notna(row.iloc[10]) else ""
            eod = str(row.iloc[11]) if pd.notna(row.iloc[11]) else ""
            notes = str(row.iloc[14]) if pd.notna(row.iloc[14]) else ""
            lines.append(
                f"DATE: {date} | Committed: {committed}hrs | Booked: {booked}hrs | BOD: {bod} | EOD: {eod} | Notes: {notes[:100]}"
            )

        return "\n".join(lines)

    except Exception as e:
        return f"Could not format EOD: {str(e)}"


def format_delay(df):
    try:
        lines = ["=== ABS DELAY QUESTIONS (Recent) ==="]
        df_clean = df.dropna(subset=[df.columns[5]]).tail(20)

        for _, row in df_clean.iterrows():
            date = str(row.iloc[0])[:10] if pd.notna(row.iloc[0]) else "N/A"
            client = str(row.iloc[2]) if pd.notna(row.iloc[2]) else "N/A"
            question = str(row.iloc[5])[:150] if pd.notna(row.iloc[5]) else ""
            reply = str(row.iloc[6])[:100] if pd.notna(row.iloc[6]) else "Pending"
            status = str(row.iloc[8]) if pd.notna(row.iloc[8]) else "Open"
            lines.append(
                f"DATE: {date} | CLIENT: {client} | Q: {question} | REPLY: {reply} | STATUS: {status}"
            )

        return "\n".join(lines)

    except Exception as e:
        return f"Could not format delay: {str(e)}"