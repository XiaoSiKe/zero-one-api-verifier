from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_detector_deploy_uses_one_path_and_installs_web_dependencies():
    deploy = (ROOT / "deploy.sh").read_text(encoding="utf-8")
    service = (ROOT / "veridrop.service").read_text(encoding="utf-8")
    assert 'RELAY_DETECTOR_PATH:-/opt/veridrop' in deploy
    assert "'.[dev,web]'" in deploy
    assert "--exclude='sso-connect/'" in deploy
    assert "fonts-noto-cjk" in deploy
    assert "WorkingDirectory=/opt/veridrop" in service
    assert "VERIDROP_WEB_DATA_DIR=/opt/veridrop/web_data" in service
    assert "ExecStartPre=/usr/bin/test -r /usr/share/fonts/opentype/noto/" in service


def test_service_only_trusts_loopback_proxy_headers():
    service = (ROOT / "veridrop.service").read_text(encoding="utf-8")
    assert "--forwarded-allow-ips='127.0.0.1,::1'" in service
    assert "--forwarded-allow-ips='*'" not in service
