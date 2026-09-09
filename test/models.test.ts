import { describe, expect, it } from 'vitest';
import { modelKey, modelFamily, parseModel, parseStorage, sameModel } from '../src/models.js';

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
