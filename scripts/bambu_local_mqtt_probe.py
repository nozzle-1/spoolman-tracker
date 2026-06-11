#!/usr/bin/env python3
"""Local Bambu MQTT probe closely modeled after ha-bambulab.

Expected cert layout if you want to mimic ha-bambulab local TLS:

scripts/bambu_certs/
  ca.cert
  emq.cert

You can override that directory with --cert-dir or bypass verification with
--insecure.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import ssl
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

try:
    import paho.mqtt.client as mqtt
except ImportError as exc:
    raise SystemExit(
        "Missing dependency: paho-mqtt\n"
        "Install it with: python3 -m pip install paho-mqtt"
    ) from exc


GET_VERSION = {"info": {"command": "get_version", "sequence_id": "0"}}
PUSH_ALL = {"pushing": {"command": "pushall", "sequence_id": "0", "version": 1}}
DEFAULT_CERT_DIR = Path(__file__).resolve().parent / "bambu_certs"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Probe a local Bambu MQTT connection with a ha-bambulab-like setup.")
    parser.add_argument("--config", default="config.json", help="Path to config.json")
    parser.add_argument("--printer-id", help="Printer id from config.json")
    parser.add_argument("--duration", type=int, default=60, help="Run duration in seconds, 0 means until Ctrl+C")
    parser.add_argument("--cert-dir", default=str(DEFAULT_CERT_DIR), help="Directory containing .cert files")
    parser.add_argument("--insecure", action="store_true", help="Disable TLS verification")
    parser.add_argument("--debug", action="store_true", help="Enable verbose paho logs")
    return parser.parse_args()


def load_printer_config(config_path: Path, printer_id: str | None) -> dict[str, Any]:
    data = json.loads(config_path.read_text(encoding="utf-8"))
    printers = data.get("printers")
    if not isinstance(printers, list):
        raise SystemExit(f'Invalid config: "printers" missing in {config_path}')

    candidates = [
        printer
        for printer in printers
        if isinstance(printer, dict)
        and printer.get("platform") == "bambulab"
        and printer.get("enabled", True) is not False
    ]
    if not candidates:
        raise SystemExit("No enabled Bambu printer found in config.")

    if printer_id is None:
        return candidates[0]

    for printer in candidates:
        if printer.get("id") == printer_id:
            return printer

    raise SystemExit(f'No enabled Bambu printer found with id "{printer_id}".')


def create_local_ssl_context(cert_dir: Path) -> ssl.SSLContext:
    context = ssl.create_default_context()
    if not cert_dir.is_dir():
        raise SystemExit(
            f"Certificate directory not found: {cert_dir}\n"
            "Copy the .cert files from ha-bambulab into that directory or use --insecure."
        )

    cert_files = sorted(path for path in cert_dir.iterdir() if path.suffix == ".cert")
    if not cert_files:
        raise SystemExit(
            f"No .cert files found in {cert_dir}\n"
            "Copy the .cert files from ha-bambulab into that directory or use --insecure."
        )

    for cert_file in cert_files:
        context.load_verify_locations(cafile=os.fspath(cert_file))

    context.verify_flags &= ~ssl.VERIFY_X509_STRICT
    context.check_hostname = False
    return context


def create_insecure_ssl_context() -> ssl.SSLContext:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return context


def format_payload(raw_payload: bytes) -> str:
    try:
        parsed = json.loads(raw_payload)
    except json.JSONDecodeError:
        return raw_payload.decode("utf-8", errors="replace")

    return json.dumps(parsed, indent=2, sort_keys=True)


class MqttThread(threading.Thread):
    def __init__(self, client: "BambuProbeClient"):
        super().__init__(daemon=True)
        self._client = client
        self._stop_event = threading.Event()

    def stop(self) -> None:
        self._stop_event.set()

    def run(self) -> None:
        print("[mqtt-thread] started")
        connection_successful = False
        last_exception_type = ""

        while not self._stop_event.is_set():
            try:
                if connection_successful:
                    print(f"[mqtt-thread] reconnecting to {self._client.host}:{self._client.port}")

                connection_successful = False
                self._client.client.connect(self._client.host, self._client.port, keepalive=5)
                connection_successful = True
                print("[mqtt-thread] entering loop_forever()")
                self._client.client.loop_forever(retry_first_connection=False)
                print("[mqtt-thread] loop_forever() exited")
                break
            except TimeoutError as exc:
                if last_exception_type != "TimeoutError":
                    print(f"[mqtt-thread] TimeoutError: {exc}")
                    last_exception_type = "TimeoutError"
                if self._stop_event.wait(5):
                    break
            except ConnectionError as exc:
                if last_exception_type != "ConnectionError":
                    print(f"[mqtt-thread] ConnectionError: {exc}")
                    last_exception_type = "ConnectionError"
                if self._stop_event.wait(5):
                    break
            except OSError as exc:
                key = f"OSError:{getattr(exc, 'errno', 'unknown')}"
                if last_exception_type != key:
                    print(f"[mqtt-thread] OSError: {exc!r}")
                    last_exception_type = key
                if self._stop_event.wait(5):
                    break
            except Exception as exc:
                print(f"[mqtt-thread] Unexpected exception: {type(exc).__name__}: {exc}")
                if self._stop_event.wait(1):
                    break

            if self._client.client is None or self._stop_event.is_set():
                break

            try:
                if connection_successful:
                    print("[mqtt-thread] disconnecting client before retry")
                    self._client.client.disconnect()
            except Exception:
                pass

        print("[mqtt-thread] exited")


class BambuProbeClient:
    def __init__(self, printer: dict[str, Any], cert_dir: Path, insecure: bool, debug: bool):
        self.host = str(printer["host"])
        self.port = int(printer.get("mqttPort", 8883))
        self.serial = str(printer["serial"]).upper()
        self.username = str(printer.get("username", "bblp"))
        self.access_code = str(printer["accessCode"])
        self.client_id = f"ha-bambulab-{uuid.uuid4()}"
        self.report_topic = f"device/{self.serial}/report"
        self.request_topic = f"device/{self.serial}/request"
        self._stop_event = threading.Event()
        self._mqtt_thread: MqttThread | None = None

        self.client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2,
            client_id=self.client_id,
            protocol=mqtt.MQTTv311,
            clean_session=True,
        )
        if debug:
            self.client.enable_logger()

        self.client.on_connect = self.on_connect
        self.client.on_disconnect = self.on_disconnect
        self.client.on_message = self.on_message
        self.client.reconnect_delay_set(min_delay=1, max_delay=30)

        if insecure:
            self.client.tls_set_context(create_insecure_ssl_context())
            self.client.tls_insecure_set(True)
        else:
            self.client.tls_set_context(create_local_ssl_context(cert_dir))

        self.client.username_pw_set(self.username, password=self.access_code)

    def start(self) -> None:
        print(f"[probe] host={self.host}:{self.port}")
        print(f"[probe] serial={self.serial}")
        print(f"[probe] client_id={self.client_id}")
        print(f"[probe] username={self.username}")
        print(f"[probe] report_topic={self.report_topic}")
        print(f"[probe] request_topic={self.request_topic}")
        self._mqtt_thread = MqttThread(self)
        self._mqtt_thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._mqtt_thread is not None:
            self._mqtt_thread.stop()
            self._mqtt_thread.join(timeout=5)
            self._mqtt_thread = None

        if self.client is not None:
            try:
                self.client.loop_stop()
                self.client.disconnect()
            except Exception as exc:
                print(f"[probe] disconnect error: {exc}")

    def subscribe_and_request_info(self) -> None:
        print(f"[subscribe] {self.report_topic}")
        self.client.subscribe(self.report_topic)
        self.publish(GET_VERSION)
        self.publish(PUSH_ALL)

    def publish(self, payload: dict[str, Any]) -> None:
        result = self.client.publish(self.request_topic, json.dumps(payload))
        print(f"[publish] rc={result.rc} topic={self.request_topic} payload={payload}")

    def on_connect(
        self,
        _client: mqtt.Client,
        _userdata: Any,
        _flags: dict[str, Any],
        reason_code: mqtt.ReasonCode,
        _properties: mqtt.Properties | None = None,
    ) -> None:
        print(f"[connect] reason_code={reason_code}")
        self.subscribe_and_request_info()

    def on_disconnect(
        self,
        _client: mqtt.Client,
        _userdata: Any,
        disconnect_flags: mqtt.DisconnectFlags,
        reason_code: mqtt.ReasonCode,
        _properties: mqtt.Properties | None = None,
    ) -> None:
        print(
            f"[disconnect] reason_code={reason_code} "
            f"server_packet={disconnect_flags.is_disconnect_packet_from_server}"
        )

    def on_message(self, _client: mqtt.Client, _userdata: Any, message: mqtt.MQTTMessage) -> None:
        timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
        print(f"\n[{timestamp}] topic={message.topic}")
        print(format_payload(message.payload))
        print()


def main() -> int:
    args = parse_args()
    config_path = Path(args.config).resolve()
    printer = load_printer_config(config_path, args.printer_id)
    cert_dir = Path(args.cert_dir).resolve()

    stop_event = threading.Event()

    def stop(*_args: Any) -> None:
        stop_event.set()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    probe = BambuProbeClient(printer, cert_dir=cert_dir, insecure=args.insecure, debug=args.debug)
    probe.start()

    try:
        if args.duration == 0:
            while not stop_event.is_set():
                stop_event.wait(1)
        else:
            stop_event.wait(args.duration)
    finally:
        probe.stop()

    return 0


if __name__ == "__main__":
    sys.exit(main())
