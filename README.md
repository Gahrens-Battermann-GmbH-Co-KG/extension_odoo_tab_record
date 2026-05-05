# G+B Odoo Tab Record — Browser-Extension installieren

Diese Anleitung erklärt, wie du die Extension **manuell** in Microsoft Edge oder Google Chrome installierst.

> **Hinweis für Administratoren:** Wenn euer IT-Team Microsoft Intune einsetzt, kann die Extension zentral auf alle Geräte verteilt werden — ohne dass jeder Nutzer diese Schritte selbst durchführen muss. Sprich dazu euren IT-Admin an.

---

## Was du brauchst

- Die Datei **`gb-odoo-tab-record.crx`** — lade sie hier herunter:  
  👉 [Download gb-odoo-tab-record.crx](https://github.com/Gahrens-Battermann-GmbH-Co-KG/extension_odoo_tab_record/releases/latest)
- Microsoft Edge **oder** Google Chrome
- Ca. 2 Minuten Zeit

---

## Schritt 1: CRX-Datei herunterladen

1. Klicke auf den Download-Link oben.
2. Der Browser lädt die Datei **`gb-odoo-tab-record.crx`** herunter.
3. Merke dir, wo die Datei gespeichert wurde (meistens: **Downloads-Ordner**).

> ⚠️ **Wichtig:** Öffne die Datei noch nicht per Doppelklick — das funktioniert bei CRX-Dateien nicht direkt. Folge stattdessen den nächsten Schritten.

---

## Schritt 2: Erweiterungsseite im Browser öffnen

**Microsoft Edge:**
1. Edge öffnen.
2. In die Adresszeile tippen: **`edge://extensions`**
3. **Enter** drücken.

**Google Chrome:**
1. Chrome öffnen.
2. In die Adresszeile tippen: **`chrome://extensions`**
3. **Enter** drücken.

---

## Schritt 3: Entwicklermodus einschalten

Auf der Seite **„Erweiterungen"** findest du oben (Edge) oder oben rechts (Chrome) den Schalter **„Entwicklermodus"**.

- Schalte ihn auf **Ein**.

Ohne diesen Schalter lässt sich die Extension nicht manuell installieren.

---

## Schritt 4: CRX-Datei per Drag & Drop installieren

1. Öffne deinen **Downloads-Ordner** (oder den Ordner, in dem du die CRX gespeichert hast).
2. Ziehe die Datei **`gb-odoo-tab-record.crx`** mit der Maus auf die geöffnete **Erweiterungsseite** im Browser.
3. Lasse sie dort los — der Browser zeigt einen Bestätigungsdialog.
4. Klicke auf **„Erweiterung hinzufügen"** / **„Add extension"**.

Die Extension erscheint jetzt in der Liste und ist aktiviert.

---

## Schritt 5: Odoo neu laden und ausprobieren

1. Wechsle zum **Tab mit Odoo**.
2. Lade die Seite neu (**F5** oder **Strg+R**).
3. Die Extension ist jetzt einsatzbereit.

---

## Wenn etwas nicht klappt

| Problem | Lösung |
|---|---|
| Browser blockiert die CRX-Datei | Entwicklermodus (Schritt 3) wirklich **eingeschaltet**? Dann nochmal Drag & Drop versuchen. |
| Kein Bestätigungsdialog erscheint | Datei direkt auf die Erweiterungsliste ziehen, nicht auf die Adresszeile. |
| Extension installiert, Odoo erkennt sie nicht | Odoo-Tab **neu laden** (F5). Gleiche Odoo-URL wie gewohnt verwenden. |
| Edge zeigt Warnung „nicht aus dem Store" | Das ist normal bei manueller Installation — mit **„Trotzdem installieren"** bestätigen. |

---

## Deinstallieren

1. `edge://extensions` oder `chrome://extensions` öffnen.
2. Bei der **G+B Odoo Tab Record** Extension auf **„Entfernen"** klicken.

---

*Bei Fragen oder Problemen wende dich an euren Odoo-Administrator oder das G+B IT-Team.*
