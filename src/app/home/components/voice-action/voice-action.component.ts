import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonIcon } from '@ionic/angular/standalone';

@Component({
  selector: 'app-voice-action',
  standalone: true,
  imports: [CommonModule, IonIcon],
  templateUrl: './voice-action.component.html',
  styleUrls: ['./voice-action.component.scss'],
})
export class VoiceActionComponent {
  @Input() isSpeaking = false;
  @Input() isListeningForCommand = false;

  @Output() startListening = new EventEmitter<void>();
  @Output() stopSpeaking = new EventEmitter<void>();
}
