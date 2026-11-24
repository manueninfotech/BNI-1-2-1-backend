import { describe, expect, it } from "vitest";
import { placeholderCompany, placeholderEmail, placeholderName, placeholderPlace } from "../placeholderProfile.js";

describe("placeholder profiles", () => {
  it("rejects test-style names", () => {
    for (const n of ["Test User", "Test Member 09", "test", "John Doe", "ss", "S", "Demo", "Dummy Account", "Member 5", "user", "asdf", "Fake Name", "Test Verification User", "123", "hhh4jjas", "a12d1cw3", "hhhjjas", "asdkjh", "Ravi123", "qwerty uiop"]) {
      expect(placeholderName(n), n).toBe(true);
    }
  });
  it("accepts real names", () => {
    for (const n of ["Ravi Teja Kolli", "Dr.K.Pawan", "Ashok M", "T.Manideep", "Testa Reddy", "Demon Kumar", "Om", "SHAIK ABDUL RAHAMAN", "Kvsn Praveen", "Abhilash", "SRIKNTH LINGAMALLU", "Sekhara Babu P.S.", "YEDUKONDALU CH", "Ch Kiran", "K NAGARJUNA KAPIL", "Lakka Nagaraju", "D'Souza", "Venkata-Ramana", "Ananthchandra"]) {
      expect(placeholderName(n), n).toBe(false);
    }
  });
  it("rejects test companies, keeps real ones", () => {
    expect(placeholderCompany("Test Company")).toBe(true);
    expect(placeholderCompany("Dummy Pvt Ltd")).toBe(true);
    expect(placeholderCompany("Manuen Infotech")).toBe(false);
    expect(placeholderCompany("Royal C@f")).toBe(false);
  });
  it("rejects test emails, keeps real ones", () => {
    for (const e of ["test.member01@mockdata.local", "testuser9515@gmail.com", "a@example.com", "x@test.com"]) expect(placeholderEmail(e), e).toBe(true);
    for (const e of ["ramprasadvenky@gmail.com", "dinesh@dt7.agency", "contest.winner@gmail.com"]) expect(placeholderEmail(e), e).toBe(false);
  });
  it("rejects random places, keeps real ones", () => {
    for (const p of ["hhh4jjas", "a12d1cw3", "xkcdqwz", "Test", "zz", "123", "guntur@"]) expect(placeholderPlace(p), p).toBe(true);
    for (const p of ["Guntur", "guntur", "Vijayawada", "Hyderabad, Telangana", "Guntur Region", "Narasaraopet", "Bhimavaram", "Navi Mumbai", "Mangalagiri (AP)"]) expect(placeholderPlace(p), p).toBe(false);
  });
});
