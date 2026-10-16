"""Exercise site management through the same forms used by admins and owners."""

from __future__ import annotations

import io
import sqlite3

import httpx
import pytest
from PIL import Image

from web import leaderboard, partner, ratelimit, server


@pytest.fixture
def catalog(tmp_path, monkeypatch):
    monkeypatch.setattr(partner, "DB_PATH", tmp_path / "partners.sqlite3")
    ratelimit.reset()
    owner = partner.register("本站站长", "owner-password-123")
    other = partner.register("其他站长", "other-password-123")
    admin = partner.create_admin("最高管理员", "admin-password-123")
    partner.submit_site(owner, "本站名称", "owned.example", "原始简介", "qq", "private-contact")
    partner.submit_site(other, "其他站点", "other.example", "其他简介", "wechat", "other-private")
    partner.set_site_status("owned.example", "approved", actor_id=admin)
    partner.set_site_status("other.example", "approved", actor_id=admin)
    site = partner.sites_for_operator(owner)[0]
    return {"owner": owner, "other": other, "admin": admin, "site": site}


def client_for(actor_id=None):
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app), base_url="http://testserver")
    if actor_id is not None:
        client.cookies.set(partner.SESSION_COOKIE, partner.new_session(actor_id))
    return client


def site_form(site, **changes):
    fields = ("name", "domain", "description", "contact_method", "contact_handle", "website_url")
    return {**{field: site[field] for field in fields}, **changes}


def paths(catalog):
    base = f"/partner/sites/{catalog['site']['id']}"
    return base + "/edit", base + "/delete"


ORIGIN = {"origin": "http://testserver"}


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["owner", "admin"])
@pytest.mark.parametrize("status", ["approved", "pending", "rejected"])
async def test_edit_fields_preserves_owner_review_and_history(catalog, role, status):
    site = catalog["site"]
    partner.set_site_status(site["domain"], status, actor_id=catalog["admin"])
    before = partner.site_for_management(catalog[role], site["id"])
    edit, delete = paths(catalog)
    async with client_for(catalog[role]) as client:
        listing = await client.get("/partner/admin?section=sites" if role == "admin" else "/partner/sites")
        if status == "approved" or role == "owner":
            assert f'href="{edit}"' in listing.text
            assert f'href="{delete}"' in listing.text
        form = await client.get(edit)
        assert form.status_code == 200
        assert 'value="private-contact"' in form.text
        assert 'value="本站名称"' in form.text
        result = await client.post(edit, data=site_form(
            site, name="更新名称", description="新简介", contact_method="wechat", contact_handle="new-private",
            operator_id=catalog["other"], status="approved", role="admin", submission_source="admin",
        ), headers=ORIGIN)
        assert result.status_code == 303
        assert "updated=1" in result.headers["location"]
        saved_page = await client.get(result.headers["location"])
        assert "站点资料已保存" in saved_page.text
    after = partner.site_for_management(catalog[role], site["id"])
    assert after["name"] == "更新名称" and after["description"] == "新简介"
    assert after["contact_method"] == "wechat" and after["contact_handle"] == "new-private"
    for field in ("id", "operator_id", "created_at", "approved_at", "submission_source", "status"):
        assert after[field] == before[field]
    event = partner.recent_events()[0]
    assert event["kind"] == "site_updated"
    assert event["actor_name"] == after["actor_name"]
    assert "new-private" not in event["detail"] and "private-contact" not in event["detail"]


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["owner", "admin"])
@pytest.mark.parametrize("change", [{"domain": "changed.example"}, {"website_url": "https://portal.example/welcome"}])
async def test_destination_change_respects_review_and_public_placements(catalog, role, change):
    site = catalog["site"]
    partner.update_ad_slot(catalog["admin"], "S1", 499, site["domain"])
    partner.set_ad_duration(catalog["admin"], "S1", 30)
    edit, _ = paths(catalog)
    async with client_for(catalog[role]) as client:
        response = await client.post(edit, data=site_form(site, **change), headers=ORIGIN)
        assert response.status_code == 303
        public = (await client.get("/api/ad-slots")).json()["slots"]
        board = await client.get("/leaderboard?board=all")
    after = partner.site_for_management(catalog[role], site["id"])
    slot = next(slot for slot in partner.ad_slots() if slot["code"] == "S1")
    assert slot["price_yuan"] == 499
    if role == "owner":
        assert after["status"] == "pending" and after["approved_at"] is None
        assert after["domain"] not in partner.approved_domains()
        assert "S1" not in public
        assert slot["site_id"] is None and slot["ends_at"] is None
        assert "本站名称" not in board.text
        # Existing review workflow can approve the updated listing.
        partner.set_site_status(after["domain"], "approved", actor_id=catalog["admin"])
        assert after["domain"] in partner.approved_domains()
        assert "S1" not in partner.public_ad_slots()  # Requires an explicit reassignment.
    else:
        assert after["status"] == "approved" and after["approved_at"] == site["approved_at"]
        assert public["S1"]["domain"] == after["domain"]
        assert public["S1"]["url"] == after["website_url"]
        assert slot["site_id"] == site["id"] and slot["ends_at"] is not None
        assert "本站名称" in board.text


@pytest.mark.asyncio
@pytest.mark.parametrize("actor", [None, "other"])
async def test_guests_and_other_owners_cannot_read_or_mutate(catalog, actor):
    edit, delete = paths(catalog)
    original = partner.site_for_management(catalog["admin"], catalog["site"]["id"])
    async with client_for(catalog[actor] if actor else None) as client:
        for method, path, data in (
            ("GET", edit, None), ("GET", delete, None),
            ("POST", edit, site_form(catalog["site"], name="越权修改")),
            ("POST", delete, {"confirmed_domain": "owned.example"}),
        ):
            response = await client.request(method, path, data=data, headers=ORIGIN)
            assert response.status_code == (404 if actor else 303)
            assert "private-contact" not in response.text
            assert "本站名称" not in response.text
            if not actor:
                assert response.headers["location"] == "/partner/login"
        if actor:
            own_list = await client.get("/partner/sites")
            assert edit not in own_list.text and "owned.example" not in own_list.text
    assert partner.site_for_management(catalog["admin"], catalog["site"]["id"]) == original
    for actor_id in (catalog["other"], 999999):
        with pytest.raises(partner.SiteNotFound):
            partner.update_site(actor_id, catalog["site"]["id"], **site_form(catalog["site"]))
        with pytest.raises(partner.SiteNotFound):
            partner.delete_site(actor_id, catalog["site"]["id"], "owned.example")


@pytest.mark.asyncio
@pytest.mark.parametrize("headers", [{}, {"origin": "https://attacker.example"}, {"origin": "null"}])
async def test_mutations_require_same_origin(catalog, headers):
    edit, delete = paths(catalog)
    async with client_for(catalog["owner"]) as client:
        assert (await client.post(edit, data=site_form(catalog["site"]), headers=headers)).status_code == 403
        assert (await client.post(delete, data={"confirmed_domain": "owned.example"}, headers=headers)).status_code == 403
    assert len(partner.sites_for_operator(catalog["owner"])) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("change,error", [
    ({"domain": " OTHER.EXAMPLE "}, "该域名已提交"),
    ({"domain": "https://invalid.example/path"}, "请填写域名"),
    ({"website_url": "javascript:alert(1)"}, "HTTPS 地址"),
    ({"website_url": "http://owned.example"}, "HTTPS 地址"),
    ({"name": "短"}, "站点名称"),
    ({"description": "长" * 501}, "500"),
    ({"contact_method": "email"}, "QQ 或微信"),
    ({"contact_handle": ""}, "联系方式的账号"),
])
async def test_invalid_edit_is_atomic_and_keeps_form_values(catalog, change, error):
    site = catalog["site"]
    partner.update_ad_slot(catalog["admin"], "S1", 499, site["domain"])
    before = partner.site_for_management(catalog["owner"], site["id"])
    events = partner.recent_events()
    edit, _ = paths(catalog)
    async with client_for(catalog["owner"]) as client:
        values = site_form(site, **({"name": "保留输入", **change}))
        response = await client.post(edit, data=values, headers=ORIGIN)
        assert response.status_code == 400
        assert error in response.text
        assert f'value="{values["contact_handle"]}"' in response.text
        assert response.headers["cache-control"] == "private, no-store"
    assert partner.site_for_management(catalog["owner"], site["id"]) == before
    assert partner.recent_events() == events
    assert partner.public_ad_slots()["S1"]["domain"] == site["domain"]


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["owner", "admin"])
async def test_confirmed_delete_clears_only_linked_ads_and_preserves_reports(catalog, role, tmp_path, monkeypatch):
    site = catalog["site"]
    picture = io.BytesIO()
    Image.new("RGB", (100, 30), "blue").save(picture, format="PNG")
    banner = partner.save_ad_banner(picture.getvalue())
    for code in ("S1", "T2"):
        partner.update_ad_slot(catalog["admin"], code, 499, site["domain"], banner_image=banner)
        partner.set_ad_duration(catalog["admin"], code, 30)
    partner.update_ad_slot(catalog["admin"], "S2", 199, "other.example")
    report_dir = tmp_path / "reports"
    report_dir.mkdir()
    report = report_dir / "sample.json"
    report.write_text('{"base_url":"https://owned.example","protocol":"openai","total_score":90,"verdict":"passed","timestamp":"2026-09-01T00:00:00Z","results":[]}')
    monkeypatch.setattr(leaderboard, "REPORT_DIRS", [report_dir])
    edit, delete = paths(catalog)
    async with client_for(catalog[role]) as client:
        page = await client.get(delete)
        assert page.status_code == 200 and 'name="confirmed_domain"' in page.text
        assert 'required' in page.text and "无法撤销" in page.text
        assert len(partner.sites_for_operator(catalog["owner"])) == 1
        for data in ({}, {"confirmed_domain": "other.example"}):
            unconfirmed = await client.post(delete, data=data, headers=ORIGIN)
            assert unconfirmed.status_code == 400
            assert len(partner.sites_for_operator(catalog["owner"])) == 1
        assert (await client.get(f"/api/ad-banners/{banner}")).status_code == 200
        response = await client.post(delete, data={"confirmed_domain": site["domain"]}, headers=ORIGIN)
        assert response.status_code == 303 and "deleted=1" in response.headers["location"]
        assert "站点已删除" in (await client.get(response.headers["location"])).text
        assert (await client.get(edit)).status_code == 404
        assert (await client.get(delete)).status_code == 404
        assert (await client.post(delete, data={"confirmed_domain": site["domain"]}, headers=ORIGIN)).status_code == 404
        assert (await client.get(f"/api/ad-banners/{banner}")).status_code == 404
        inactive_ad = await client.get("/out/ad/S1")
        assert inactive_ad.status_code == 303 and inactive_ad.headers["location"] == "/leaderboard"
    assert partner.sites_for_operator(catalog["owner"]) == []
    assert len(partner.sites_for_operator(catalog["other"])) == 1
    assert set(partner.public_ad_slots()) == {"S2"}
    for slot in partner.ad_slots():
        if slot["code"] in {"S1", "T2"}:
            assert slot["site_id"] is None and slot["target_url"] == ""
            assert not slot["banner_image"] and not slot["banner_image_2"]
            assert slot["starts_at"] is None and slot["ends_at"] is None
            assert slot["price_yuan"] == 499
    assert report.exists() and leaderboard.aggregate_one(site["domain"]) is not None
    event = partner.recent_events()[0]
    assert event["kind"] == "site_deleted" and "cleared_slots=2" in event["detail"]
    assert "private-contact" not in event["detail"]
    with sqlite3.connect(partner.DB_PATH) as conn:
        assert conn.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


@pytest.mark.asyncio
async def test_edit_escapes_content_and_stale_delete_requires_new_confirmation(catalog):
    edit, delete = paths(catalog)
    async with client_for(catalog["admin"]) as client:
        assert (await client.get(delete)).status_code == 200
        result = await client.post(edit, data=site_form(
            catalog["site"], name='<script>alert("x")</script>', domain="renamed.example", website_url="",
        ), headers=ORIGIN)
        assert result.status_code == 303
        response = await client.get(edit)
        assert "<script>alert" not in response.text and "&lt;script&gt;" in response.text
        stale = await client.post(delete, data={"confirmed_domain": "owned.example"}, headers=ORIGIN)
        assert stale.status_code == 400
        assert "renamed.example" in partner.approved_domains()


@pytest.mark.parametrize("action", ["edit", "delete"])
def test_audit_failure_rolls_back_listing_and_ad_changes(catalog, monkeypatch, action):
    site = catalog["site"]
    partner.update_ad_slot(catalog["admin"], "S1", 499, site["domain"])

    def unavailable_audit(*args, **kwargs):
        raise sqlite3.OperationalError("simulated audit failure")

    monkeypatch.setattr(partner, "_insert_event", unavailable_audit)
    with pytest.raises(sqlite3.OperationalError, match="audit failure"):
        if action == "edit":
            partner.update_site(catalog["owner"], site["id"], **site_form(site, domain="changed.example"))
        else:
            partner.delete_site(catalog["owner"], site["id"], site["domain"])
    assert partner.site_for_management(catalog["owner"], site["id"])["domain"] == site["domain"]
    assert partner.public_ad_slots()["S1"]["domain"] == site["domain"]
