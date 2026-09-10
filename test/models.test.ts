import { describe, expect, it } from 'vitest';
import { extractModelCode, modelKey, modelFamily, modelsMatch, parseModel, parseStorage, sameModel } from '../src/models.js';

describe('parseStorage', () => {
  it('never mistakes RAM for storage', () => {
    // This exact error split one MacBook Air M2 across four groups.
    expect(parseStorage('Apple MacBook Air M2 13.6" 8GB RAM 256GB NVMe SSD').storageGb).toBe(256);
    expect(parseStorage('MacBook Air M2 256gb And 16gb Ram chip M2').storageGb).toBe(256);
    expect(parseStorage('MacBook Air A2681 2022 13" - M2 - 16GB RAM - 512GB SSD').storageGb).toBe(512);
  });

  it('reports no capacity for a multi-configuration listing', () => {
    for (const t of [
      'Apple iPhone 15 Pro 128/256/512GB/1TB Unlocked',
      'APPLE IPHONE 15 128GB 256GB 512GB (FACTORY UNLOCKED)',
      'Apple iPad Air 2 9.7in 16GB 32GB 64GB 128GB',
    ]) {
      const r = parseStorage(t);
      expect(r.multiStorage).toBe(true);
      expect(r.storageGb).toBeNull();
    }
  });

  it('reads a single capacity, spaced or not, and converts TB', () => {
    expect(parseStorage('iPhone 15 pro max Factory 256 GB').storageGb).toBe(256);
    expect(parseStorage('iPhone 15 Pro 1TB Unlocked').storageGb).toBe(1024);
    expect(parseStorage('iPhone 15 Plus 128Gb').storageGb).toBe(128);
  });

  it('reports nothing when the title states no capacity', () => {
    expect(parseStorage('iPhone 15 pro Max factory sim físico').storageGb).toBeNull();
  });
});

describe('modelKey', () => {
  it('keeps Pro Max distinct from Pro', () => {
    // Collapsing these priced a Pro Max against a Pro, hundreds of dollars apart.
    expect(modelKey('Apple iPhone 15 Pro Max 256GB Black Titanium')).toBe('iPhone 15 Pro Max 256GB');
    expect(modelKey('Apple iPhone 15 Pro 256GB A2848 Unlocked')).toBe('iPhone 15 Pro 256GB');
  });

  it('separates every Galaxy S23 trim', () => {
    expect(modelKey('Samsung Galaxy S23 128GB S911U Unlocked')).toBe('Galaxy S23 128GB');
    expect(modelKey('Samsung Galaxy S23+ 256GB S916U Unlocked')).toBe('Galaxy S23 Plus 256GB');
    expect(modelKey('Samsung Galaxy S23 Ultra 512GB S918U')).toBe('Galaxy S23 Ultra 512GB');
    expect(modelKey('Samsung Galaxy S23 FE 128GB S711U Unlocked')).toBe('Galaxy S23 FE 128GB');
  });

  it('reunites one MacBook model that RAM parsing had split apart', () => {
    const titles = [
      'Apple MacBook Air M2 13.6" 8C/8C 3.5GHz 8GB RAM 256GB NVMe SSD A2681',
      '2022 Apple MacBook Air 13.6" M2 8C GPU 3.5GHz 8GB RAM 256GB SSD A2681',
      'Apple MacBook Air 13.6" (256GB SSD, M2, 8GB) Laptop - Midnight',
    ];
    expect(new Set(titles.map(modelKey))).toEqual(new Set(['MacBook Air M2 256GB']));
  });

  it('keeps the iPad generation instead of dropping it', () => {
    expect(modelKey('Apple iPad Air 4 Wi-Fi Only - 64GB - 10.9"')).toBe('iPad Air 4 64GB');
    expect(modelKey('WiFi Only Apple iPad Air 4th Gen 64GB Blue')).toBe('iPad Air 4 64GB');
    expect(modelKey('Apple iPad Air 5th Generation 10.9" 64GB WiFi')).toBe('iPad Air 5 64GB');
  });

  it('separates watch case sizes, which price differently', () => {
    expect(modelKey('Apple Watch Series 9 GPS 41mm Silver Aluminum')).toBe('Apple Watch Series 9 41mm');
    expect(modelKey('GPS Only Apple Watch Series 9 45MM Midnight Aluminum')).toBe('Apple Watch Series 9 45mm');
  });

  it('handles Spanish seller titles', () => {
    expect(modelKey('iPhone 15 pro max Factory 256 GB batería 85')).toBe('iPhone 15 Pro Max 256GB');
    expect(modelKey('iPhone 15 plus 128 GB Factory 86%bateria')).toBe('iPhone 15 Plus 128GB');
  });

  it('does not group unknown products by filler words', () => {
    // The old fallback took the first two words, grouping on "Apple iPhone"
    // and "New Samsung".
    expect(modelKey('New Sealed Sony WH-1000XM5 Headphones')).not.toMatch(/^New/);
  });
});

describe('accessory detection', () => {
  it('flags parts and accessories that name the device', () => {
    for (const t of [
      'Apple iPhone 15 Pro Max Backhousing Used Replacement Part OEM',
      'OLED For iPhone 15 Pro Max Touch Screen Replacement Display Digitizer',
      'For iPhone 15/15PRO Back Glass Replacement Big Hole Rear Cover',
      'Genuine Original Leather/ Silicone Case for Apple iPhone 15',
      'Apple iPhone Retail Box Packaging Purple 128GB',
      'Lot of 4 Smartphones Apple iPhone Samsung',
    ]) {
      expect(parseModel(t).isAccessory, t).toBe(true);
    }
  });

  it('does not flag a real device', () => {
    for (const t of [
      'Apple iPhone 15 Pro 256GB A2848 Unlocked Very Good Condition',
      'Samsung Galaxy S23 Ultra 512GB S918U Unlocked - Good',
      'Apple MacBook Air 13.6" M2 8GB RAM 256GB SSD',
    ]) {
      expect(parseModel(t).isAccessory, t).toBe(false);
    }
  });
});

describe('sameModel', () => {
  it('treats an unstated capacity as compatible', () => {
    expect(sameModel('iPhone 15 Pro 256GB', 'iPhone 15 Pro')).toBe(true);
  });

  it('refuses a different trim or generation', () => {
    expect(sameModel('iPhone 15 Pro Max 256GB', 'iPhone 15 Pro 256GB')).toBe(false);
    expect(sameModel('iPhone 13 128GB', 'iPhone 15 Pro')).toBe(false);
    expect(sameModel('Galaxy S23 Ultra', 'Galaxy S23')).toBe(false);
    expect(sameModel('iPad Air 4 64GB', 'iPad Air 5 64GB')).toBe(false);
  });
});

describe('modelFamily', () => {
  it('drops capacity so configurations of one model share a family', () => {
    expect(modelFamily('Apple iPhone 15 Pro 256GB Unlocked')).toBe('iPhone 15 Pro');
    expect(modelFamily('Apple iPhone 15 Pro 128GB Unlocked')).toBe('iPhone 15 Pro');
    expect(modelFamily('Apple MacBook Air M2 8GB RAM 512GB SSD')).toBe('MacBook Air M2');
  });
});

describe('confidence', () => {
  it('is high only when a specific product was named', () => {
    for (const t of [
      'Apple iPhone 15 Pro Max 256GB Unlocked',
      'Dell Latitude 5420 14" Touch Laptop i5-1145G7',
      'Lenovo ThinkPad T14s Gen 2i Core i7',
      'Samsung Galaxy S23 Ultra 512GB',
    ]) {
      expect(parseModel(t).confidence, t).toBe('high');
    }
  });

  it('is low when the title never names a model', () => {
    // These are real Facebook titles. No parser can recover a model that the
    // seller did not write down.
    for (const t of ['Laptop Lenovo', 'Laptop Gamer', 'Laptop', 'Laptop hp 15ba022nr'.replace('15ba022nr', '')]) {
      expect(parseModel(t).confidence, t).toBe('low');
    }
  });

  it('is medium for a product line with no model identifier', () => {
    expect(parseModel('Dell Latitude 14" Laptop Computer Intel i5').confidence).toBe('medium');
    expect(parseModel('Laptop Dell Latitude 8 de ram, 128 ssd').confidence).toBe('medium');
  });

  it('does not mistake a screen size for a model number', () => {
    // "Dell Latitude 14" is a 14-inch screen; "Dell Latitude 5420" is a model.
    expect(modelKey('Dell Latitude 14" Laptop Computer Intel i5')).toBe('Dell Latitude');
    expect(modelKey('Dell Latitude 5420 14" Touch Laptop')).toBe('Dell Latitude 5420');
  });

  it('normalizes case so one model cannot become two groups', () => {
    expect(modelKey('HP EliteBook 840 G8 i5')).toBe(modelKey('HP Elitebook 840 G8 i5'));
  });
});

describe('consoles', () => {
  it('normalizes every spelling sellers use for one console', () => {
    // These were six separate groups of the same product.
    const digital = [
      'PlayStation 5 Slim Digital (Nuevo Sellado)',
      'Ps5 Slim digital totalmente nuevo.',
      'Vendo PS5 Slim Digital o Cambio por Xbox series X',
      'Sony PlayStation 5 Slim Digital Edition Gaming Console',
    ];
    expect(new Set(digital.map(modelKey))).toEqual(new Set(['PlayStation 5 Slim Digital']));
  });

  it('keeps Digital and Disc apart, since they do not price alike', () => {
    expect(modelKey('Ps5 slim de disco')).toBe('PlayStation 5 Slim Disc');
    expect(modelKey('PS5 Slim Digital')).toBe('PlayStation 5 Slim Digital');
    expect(modelKey('PLAYSTATION 5 PRO DIGITAL 2TB')).toBe('PlayStation 5 Pro Digital 2TB');
  });

  it('reads Spanish capacity and edition wording', () => {
    expect(modelKey('Play station 5 slim versión disco 1 tb de almacenamiento'))
      .toBe('PlayStation 5 Slim Disc 1TB');
  });

  it('classifies Xbox and Switch', () => {
    expect(modelKey('Xbox Series X 1TB Console')).toBe('Xbox Series X 1TB');
    expect(modelKey('Nintendo Switch OLED 64GB')).toBe('Nintendo Switch OLED');
    expect(modelKey('Nintendo Switch Lite')).toBe('Nintendo Switch Lite');
  });

  it('does not read the Switch OLED as a phone screen part', () => {
    // "OLED" earned its place in the accessory rule via phone screens; on a
    // Switch it is the model name.
    expect(parseModel('Nintendo Switch OLED 64GB').isAccessory).toBe(false);
    expect(parseModel('OLED For iPhone 15 Pro Max Touch Screen Replacement Display').isAccessory).toBe(true);
  });

  it('flags console spare parts', () => {
    for (const t of [
      'Sony PlayStation 5 PS5 SLIM Replacement Disc Drive CFI-ZDD1',
      'Sony PlayStation 5 PS5 SLIM Motherboard Replacement CFI-2115',
    ]) {
      expect(parseModel(t).isAccessory, t).toBe(true);
    }
  });
});

describe('modelsMatch', () => {
  const m = (t: string) => parseModel(t);

  it('treats an unstated edition as compatible, not as a third product', () => {
    // A seller who wrote "PS5 Slim" did not name a console that is neither
    // Digital nor Disc.
    expect(modelsMatch(m('PS5 Slim'), m('PS5 Slim Digital'))).toBe(true);
    expect(modelsMatch(m('PS5 Slim'), m('PS5 Slim Disc'))).toBe(true);
  });

  it('refuses two stated editions that differ', () => {
    expect(modelsMatch(m('PS5 Slim Digital'), m('PS5 Slim Disc'))).toBe(false);
  });

  it('refuses a different trim even when everything else agrees', () => {
    expect(modelsMatch(m('PS5 Slim Digital'), m('PS5 Pro Digital'))).toBe(false);
    expect(modelsMatch(m('iPhone 15 Pro 256GB'), m('iPhone 15 Pro Max 256GB'))).toBe(false);
  });

  it('treats capacity as a wildcard only when one side omits it', () => {
    expect(modelsMatch(m('PS5 Slim Digital'), m('PS5 Slim Digital 1TB'))).toBe(true);
    expect(modelsMatch(m('iPhone 15 Pro 128GB'), m('iPhone 15 Pro 512GB'))).toBe(false);
  });
});

describe('manufacturer model codes', () => {
  it('collapses every spelling of one code into one product', () => {
    // These were four groups; the fallback also truncated at the hyphen, which
    // merged WH-1000XM4 with WH-1000XM5 under "Audifonos Sony Wh".
    const same = [
      'Audífonos Sony WH-1000XM4',
      'Auriculares Sony WH-1000XM4',
      'Sony WH-1000XM4',
      'sony wh-1000xm4',
      'Sony wh1000xm4 nuevo sellado Original',
      'Sony WH1000XM4/S Premium Noise Cancelling Wireless',
      'Sony wh 1000xm4',
    ];
    expect(new Set(same.map(modelKey))).toEqual(new Set(['Sony WH1000XM4']));
  });

  it('never merges neighbouring codes, which differ by one character', () => {
    const keys = ['Sony WH-1000XM4', 'Sony WH-1000XM5', 'Sony WH-1000XM6', 'Sony WH-CH520'].map(modelKey);
    expect(new Set(keys).size).toBe(4);
  });

  it('does not read a brand word as part of the code', () => {
    expect(extractModelCode('Sony wh1000xm4 nuevo')).toBe('WH1000XM4');
  });

  it('ignores CPU part numbers, capacity and resolution', () => {
    expect(extractModelCode('Dell Latitude 14" Laptop Intel i5-1145G7 16GB RAM')).not.toBe('I51145G7');
    expect(extractModelCode('Samsung 65" 4K TV 60Hz 500GB')).toBeNull();
  });
});

describe('accessory words that are also products', () => {
  it('does not treat headphones as an accessory', () => {
    // "headphone"/"headset"/"airpods" were accessory keywords, which flagged
    // 13 of 60 real WH-1000XM4 listings and removed them from their own group.
    for (const t of [
      'Sony WH-1000XM4 Over the Ear Wireless Headset - Black',
      'Sony WH-1000XM4 Over-Ear Headphones Light Gray Noise Canceling w/ Case',
      'Sony WH-1000XM4 Black Bluetooth Wireless Headphone w/ Case. Excellent',
      'Sony WH-1000XM4 Blue - NEW EARCUPS & Complete Original Packaging',
    ]) {
      expect(parseModel(t).isAccessory, t).toBe(false);
    }
  });

  it('still catches the listing whose subject is the case', () => {
    for (const t of [
      'Genuine Sony WH-1000XM3 WH-1000XM4 XM2 Headphones Hard Case Black Zipper',
      'Sony Original Carrying Case For Headphones SONY WH-1000XM4/B BLACK',
      'Replacement For Sony WH-1000XM4 Headphones Plastic Hinge Swivel',
      'Apple iPhone Retail Box Packaging Purple 128GB',
    ]) {
      expect(parseModel(t).isAccessory, t).toBe(true);
    }
  });

  it('reads an included extra as an extra, not as the product', () => {
    expect(parseModel('Apple iPhone 15 Pro 256GB Unlocked - includes case and charger').isAccessory).toBe(false);
  });
});
